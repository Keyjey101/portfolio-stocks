# 03. Детерминированный движок оценки (intrinsic_value)

Ядро системы. На вход — датасет из `data_agent` + `financial_metrics`; на выходе —
`{base, bear, bull, epv, mos, score, methods[], ...}`. Никакого LLM внутри —
LLM-агент (`05`, §3) лишь пишет нарратив поверх готовых чисел и не имеет права
их менять.

## 3.1. Стоимость капитала

```
rf   = посл. значение 10Y UST из macro_indicators (÷100), clamp [0.01, 0.08]; дефолт 0.043
beta = clamp(0.67 · clamp(raw_beta, 0, 2.5) + 0.33, 0.70, 2.20)   # Blume-коррекция
erp  = 0.055
ke   = rf + beta · erp,                clamp [rf + 0.045, 0.22]
kd   = |interest_expense| / |total_debt| при наличии, иначе 0.06;  clamp [0.02, 0.15]
tax  = медиана (1 − NI/EBT) за ≤6 лет (EBT ≈ op_income − |interest|), только где 0 < NI < EBT;
       clamp [0.10, 0.35]; дефолт 0.21
D    = max(0, EV − market_cap), иначе total_debt
WACC = E/V · ke + D/V · kd · (1 − tax), clamp [rf + 0.025, 0.20]
```

## 3.2. Нормализованная прибыль (Greenwald)

Нормализуется **маржа** (медиана по окну; отношения вне [−1.0, 0.85] отбрасываются),
затем × текущая выручка:

- нецикличная компания: маржа = медиана за 3 года, выручка = текущая;
- цикличная: и маржа, и выручка — медианы полного цикла (до 10 лет).

Применяется к `operating_income → norm_ebit` и `ebitda → norm_ebitda`.
Абсолютный фоллбек: медиана долларов (цикличная) / среднее 4 лет (стабильная).
Флаг `is_cyclically_adjusted`.

**Базовый FCFF**: медиана серии FCF (8 лет цикличная / 4 стабильная, только
положительные); если непригодна — прокси из нормализованной NI (флаг
`fcf_proxied_from_earnings`); затем `fcff0 += |interest_0| · (1 − tax)`.

## 3.3. Центральный рост g

```
rev_g        = median(revenue_cagr_3y, revenue_cagr_5y)
margin_allow = 0.03 (0, если маржа падает)
g_cap        = rev_g + margin_allow          (0.12, если rev_g нет)
кандидаты    = [eps_cagr_5y, eps_cagr_3y, analyst.eps_growth_next_year] каждый min(c, g_cap) + [rev_g]
g            = median(кандидаты)             (фоллбек 0.03)
если тренд выручки declining:  g = min(g, max(rev_g or 0, −0.08))
финальный clamp:               g = clamp(g, −0.10, +0.40)
```

**Горизонт DCF**: цикличная → 5 лет; `roic ≥ 0.12 и g ≥ 0.12` → 10; `g ≥ 0.08` → 7; иначе 5.

## 3.4. Методы оценки (все дают стоимость на акцию)

Терминальный рост: `g_t = min(0.025, rf, wacc − 0.03, max(0, g))`;
DCF отбрасывается, если `wacc − g_t < 0.03`.

1. **DCF value-driver (основной).** `FCFF_t = NOPAT_t · (1 − g_t/ROIC)`,
   ROIC clamp [0.04, 0.60], реинвестиции `max(0, min(0.95, g/roic))`; рост линейно
   гасится от g до g_t за горизонт; терминал по Гордону
   `NOPAT_T · (1 − RR(g_t)) / (wacc − g_t)`; equity = EV − net_debt (чистая наличка
   прибавляется); ÷ shares. `nopat0 = max(GAAP NOPAT, cash NOPAT = (norm_ebitda −
   norm_capex)·(1 − tax))`.
2. **Простой двухстадийный FCFF DCF** (фоллбек): FCFF растёт с затуханием, Гордон, то же требование спреда ≥ 3 п.п.
3. **EPV (Greenwald)**: `(norm_ebit · (1 − tax) / wacc − net_debt) / shares`.
4. **Обоснованный P/E**: `P/E = (1 − retention)·(1 + g_pe) / max(ke − g_pe, 0.03)`,
   `g_pe = min(g, 0.06)`, `retention = min(0.90, g_pe/roic)` (0.5 без ROIC);
   P/E clamp [6, 30]; × forward_eps (фоллбек trailing).
5. **Обоснованный EV/EBITDA**: `mult = clamp(8 + 50·g, 6, 22)`;
   `(mult · norm_ebitda − net_debt) / shares`.
6. **Грэм**: `sqrt(22.5 · eps_norm · bvps)`, eps_norm = средняя NI/акции за 5 лет,
   капится на 1.5 × trailing.
7. **Обоснованный P/B** (эффективен только для банков/страховщиков):
   `P/B = (ROE − g_s)/max(ke − g_s, 0.04)`, `g_s = min(g, 0.03)`, clamp [0.4, 2.5]; × bvps.
8. **Аналитики**: `target_mean / (1 + ke)` (дисконт 12-мес. цели к сегодняшнему дню), низкий вес.

**Нормализация ROIC**: `cash_roic = (max(0, norm_ebitda − norm_capex)·(1 − tax)) /
invested_capital`; берётся `max(gaap_roic, cash_roic)`. Если GAAP ROIC < 8%, но
маржа EBITDA > 18% и fcff0 > 0 → ROIC поднимается до 0.15, флаг `roic_normalized`
(влечёт `asset_light`).

## 3.5. Веса методов

| Профиль компании | Веса |
|---|---|
| Дефолт | dcf .30, epv .15, pe .22, ev_ebitda .15, graham .08, analyst .10 |
| Капиталоёмкие секторы (Financials, Real Estate, Utilities, Materials) | dcf .22, epv .20, pe .15, ev_ebitda .13, graham .20, analyst .10 |
| Банки/страховщики (industry содержит bank/insurance/insurer/reinsurance/mortgage) | **pb .45, pe .25, graham .15, analyst .15** (DCF/EPV/EV-EBITDA выключены) |
| Asset-light (ROIC ≥ 0.22, нецикличная, нефинансовая, или roic_normalized) | dcf .42, pe .34, ev_ebitda .14, analyst .10 |

**Проба стабильности DCF**: DCF считается при `[g, g±0.05, консенсус]`; если
max/min > 2.0 → `weight_dcf *= max(0.1, 2.0/range)`.

## 3.6. Робастная агрегация

1. Якорь = взвешенная медиана «going-concern» методов `{dcf, pe, ev_ebitda, analyst, pb}`.
2. Для каждого метода эффективный вес затухает по отношению значения к якорю:
   внутри `τ = 2.0` — полный вес, иначе `(2.0/ratio)^1.0`.
3. `base = Σ(value · eff_w) / Σ(eff_w)`; дисперсия методов в log-пространстве — `σ_disp`.

## 3.7. Сценарии bear / bull

Дельты драйверов масштабируются бета:

```
dg = clamp(0.02 + 0.02·beta (+0.015 цикличная), 0.02, 0.08)     # рост
dw = clamp(0.005 + 0.006·beta, 0.005, 0.020)                    # WACC/ke
dm = clamp(0.06 + 0.05·beta, 0.06, 0.20)                        # маржа (× (1−dm))
```

Полный блэнд пересчитывается на драйверах `(g−dg, wacc+dw, ke+dw, margin×(1−dm))`
(bear-driver) и `(g+dg, wacc−dw, ke−dw, margin×(1+dm))` (bull-driver).
Затем **сценарный конус лог-нормальный**:

```
σ_driver = |ln(bull_drv / bear_drv)| / 2
σ_disp   = min(0.50, σ_method)
σ_total  = clamp(sqrt(σ_driver² + σ_disp²), 0.08, 0.60)
bear = base · e^{−1.0·σ};   bull = base · e^{+1.0·σ}          # Z = 1
expected_value = 0.25·bear + 0.50·base + 0.25·bull
```

## 3.8. Санити и гейты надёжности

- Нет ни одного метода → `base = price (или 100)`, `data_quality = "insufficient_data"`.
- `base` вне `[0.20·price, 5.0·price]` → клампится, `data_quality = "clamped_vs_price"`.
- `method_spread_ratio` = max/min по **ядерным** методам `{dcf, pe, ev_ebitda, pb}`.
- `high_dispersion` = σ_disp > 0.35 или spread > 2.5 → флаг `high_method_dispersion`.
- `low_reliability` = spread > 2.5 → флаг; обнуляет вклад оценки в скор (см. `04`).
- **`no_estimate`** = (spread > 3.0) ИЛИ (clamped_vs_price) ИЛИ
  (`fv_target_gap = |base − analyst_target|/price > 1.0`) ИЛИ высокоцикличная компания
  → флаги `no_estimate` (+`cyclical_range_only` для цикличных).
- Диапазон показа = min/max от (bear, bull, все методы); для высокоцикличных
  расширяется минимум до `[0.6·base, 1.6·base]`.

**«Поддержано против заложено в цену» (G1)**: `supported_value` = EPV (для финансовых —
bvps, крайний случай — Грэм); `priced_in = round(price − supported_value, 2)`;
генерируется текстовый `framing`: «текущая отчётность поддерживает ≈ $X/акцию без
роста; в цене заложено $Y будущих денежных потоков» (варианты: цикличная компания /
оплата будущего роста / уже поддержано).

## 3.9. MoS и скор оценки

```
mos   = round((base − price) / price × 100, 1)          # единственный источник истины
score = margin_of_safety_score(mos):
    mos > 30 → 9;  > 15 → 7;  > −10 → 5;  > −25 → 3;  иначе 1;  None → 5
```

После LLM-фазы оркестратор **канонически пересчитывает** `mos` и `score` из
`dcf_base` и цены — любые числа, пришедшие из LLM, игнорируются.

## 3.10. Выход движка (поля)

```
base, bear, bull, expected_value, probabilities{bear:0.25, base:0.50, bull:0.25},
epv (=floor), mos, score, methods[{name, value, weight}],
analyst_target, analyst_target_pv, wacc, ke, growth, terminal_growth,
dispersion, dispersion_flag, method_spread_ratio, low_reliability, asset_light,
no_estimate, range_low, range_high, fv_target_gap, supported_value, priced_in,
framing, valuation_flags[], assumptions (строка диагностики), data_quality
∈ {ok, clamped_vs_price, insufficient_data}, is_cyclically_adjusted, price
```

Внешний слой (`valuation_agent`) добавляет legacy-имена для фронтенда:
`dcf_base/dcf_bear/dcf_bull`, `cost_of_equity`, `growth_used`, `valuation_floor`,
`earnings_power_value`, `margin_of_safety_pct`, `valuation_score`,
`valuation_narrative` (LLM), `relative_assessment` (LLM), `dcf_assumptions`.

## 3.11. Financial-агент (вход для весов и скоров; без LLM)

Скоры 0–10 (влиятельны в `04`):

- **growth**: CAGR выручки 3 г: ≥15% → 9.5; ≥10% → 8.0; ≥5% → 6.5; ≥2% → 5.0; ≥0 → 3.5; иначе 1.5 (±1.5/±0.5 по тренду).
- **profitability**: средняя опер. маржа 5 лет: ≥25% → 9.5; ≥15% → 8.0; ≥8% → 6.5; ≥3% → 4.5; ≥0 → 3.0; иначе 1.0.
- **efficiency**: средний ROIC 5 лет: ≥20% → 9.5; ≥15% → 8.0; ≥10% → 6.5; ≥5% → 4.5; иначе 2.5.
- **cashflow**: доля FCF-положительных лет: ≥0.85 → 9.0; ≥0.65 → 7.5; ≥0.45 → 6.0; ≥0.25 → 4.0; иначе 2.0 (+1 за конверсию; −1.5 debt/EBITDA > 4; −1 current_debt_ratio > 0.3; −1.5 interest coverage < 2).
- `financial_strength_score = 0.25·growth + 0.30·profitability + 0.25·efficiency + 0.20·cashflow`.

Дополнительно: цикличность (сектор + подтверждение данными: σ маржи ≥ 0.06 или
просадка выручки ≥ 0.20; структурные кейворды shipping/commodity/semiconductor
обходят вето), упрощённый Piotroski F (макс. 7), `eps_quality_flag`
(`divergence = (pe_fwd − pe_trail)/pe_trail`: > 0.5 suspicious_trailing_pe;
> 0.3 likely_one_time_gain; < −0.15 expected_growth; иначе normal),
`accruals_ratio = (NI − OCF)/assets` (+1 Piotroski при < 0.05), `debt_stress_flag`.
