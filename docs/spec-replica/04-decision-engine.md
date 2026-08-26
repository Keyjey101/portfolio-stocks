# 04. Decision engine: скор, вердикт, уверенность, гейты

Вход: `financial_metrics`, `business` (LLM), `valuation`, `risk` (LLM),
`sec_filing_data`, `degraded_agents`, `event_flags`. Выход — блок `decision`.

## 4.1. Компоненты скора (каждый 0–100)

`normalize(x_0_10) = x × 10`.

| Компонент | Формула | Жёсткие overrides |
|---|---|---|
| business_quality | `normalize(business_score)·0.6 + normalize(moat_score)·0.4` | op. маржа > 40% и ROIC > 20% ⇒ ≥ 70; средний ROIC < 0 ⇒ ≤ 40 |
| financial_strength | `profitability·0.40 + efficiency·0.33 + cashflow·0.27` (в 0–100) | — (growth исключён — у него свой компонент) |
| growth | `normalize(growth_score)` | — |
| valuation | `normalize(valuation_score)`; **50.0 (нейтрально)** при `low_reliability` или `no_estimate` | — |
| risk | `normalize(10 − risk_score)` | value_trap −20; opportunity +5 |

**Веса компонентов** (по сектору; в оригинале на этом пути фактически всегда дефолт):

| Сектор | business | financial | growth | valuation | risk |
|---|---|---|---|---|---|
| Дефолт | .30 | .25 | .20 | .15 | .10 |
| Financials | .20 | .35 | .15 | .15 | .15 |
| Technology | .25 | .15 | .30 | .15 | .15 |
| Energy / Materials / Real Estate | .20 | .25 | .10 | .30 | .15 |
| Consumer Staples | .30 | .25 | .15 | .20 | .10 |
| Consumer Discretionary | .25 | .20 | .30 | .15 | .10 |

`total_score = Σ компонента × вес` (1 знак); штраф −5, если высокоцикличная и
маржа падает.

## 4.2. SEC-модификаторы (только при `data_available`)

| Условие | Δ скор |
|---|---|
| выручка ↑ и долг ↓ | +2 |
| инсайдеры: продажи > 3× покупок | −4 |
| инсайдеры: покупки > 2× продаж | +2 |
| margin_change > 2 п.п. | +1 |
| fcf_change_pct > 10% | +1 |
| 8-K `restatement` | −5 за событие |
| 8-K `leadership_change` | −2 за событие |
| filing_tone cautious/negative | −2 |
| filing_tone positive | +1 |
| институциональная notable_activity | +1 |

## 4.3. Вердикт

Пороги: `Strong Buy ≥ 75`, `Buy ≥ 60`, `Hold ≥ 40`, иначе `Avoid` (первый
выполненный побеждает). Затем **последовательные гейты** (порядок важен):

1. **Value-trap guard**: скор < 70 → `Avoid`; иначе Buy/Strong Buy → `Hold`.
2. **Гейты MoS** (пропускаются при `low_reliability`):
   - `MoS ≤ −50` или (флаг переоцененности из risk-агента и `MoS ≤ −35`) → `Avoid`;
   - `MoS ≤ −25` и вердикт Buy/Strong Buy → `Hold`;
   - `|MoS| < 5` и вердикт Strong Buy/Buy/Avoid → `Hold` («около справедливой цены»).
3. `asset_light` + Avoid (не value_trap) → `Hold`.
4. `degraded_agents > 0` и Buy/Strong Buy → `Hold`.
5. **Hard gate `No Decision`**: `no_estimate` ИЛИ `degraded_agents > 0` ИЛИ
   `stale_filing` (D1) ИЛИ `active_ma_offer` (D3) ИЛИ `unexplained_move_severe` (D4+) → вердикт `No Decision`.
6. D4 `unexplained_move` и вердикт ∈ {Strong Buy, Buy, Avoid} → `Hold`.

## 4.4. Уверенность (confidence_pct)

База 50, затем:

| Условие | Δ |
|---|---|
| FCF-положительных лет ≥ 85% из ≥ 3 доступных | +10 |
| Piotroski ≥ 7 / ≤ 3 | +10 / −10 |
| moat_score ≥ 7 | +10 |
| mispricing ∈ {opportunity, value_trap} | +5 |
| высокоцикличная | −15 |
| SEC data_available | +5 |
| dispersion_flag | −10 |

Clamp [20, 90]. **Кэпы**: `low_reliability` → ≤ 40; `degraded_agents > 0` →
≤ `45 − 5·n`; вердикт `No Decision` → ≤ 35; `unexplained_move` → ≤ 40;
`asset_light` и |MoS| ≥ 25 → ≤ 55; каждый структурный sanity-флаг
(`gross_profit_implausible`, `revenue_discontinuity`, `negative_book_equity`) →
`min(conf, 55) − 10·n`.

**Связь скора и уверенности**: `total_score = min(total_score, 40 + 0.6 · confidence_pct)`
— высокая оценка не может быть обоснована при низкой уверенности.

## 4.5. Self-critique (LLM, только при confidence ≥ 80)

Один вызов (temp 0.3, 512 токенов), роль «скептичный риск-менеджер хедж-фонда».
Вход: тикер, вердикт, уверенность, mispricing, risk score, moat, инсайдерский
сигнал, filing tone, институциональная активность. Вопрос: «аргументы против
(medведьи), обоснована ли уверенность, что упущено». Выход JSON:
`{bear_case (2–3 предложения), confidence_adjustment (int −20..+5),
missed_risks[1–3], final_assessment ∈ {proceed, caution, strong_caution}}`.
`confidence += adjustment` (с повторным клампом); `strong_caution` → дополнительно −10.
Фоллбек: нулевая корректировка, `proceed`.

## 4.6. Mispricing type

Из risk-агента: `opportunity | value_trap | fairly_valued | overvalued_justified |
overvalued_bubble`. **Сверка с вердиктом**: противоречие (например, `opportunity`
при `Avoid`) → приводится к `unknown`.

## 4.7. Event-флаги D1–D4 (вычисляются на шаге news_radar)

«Материальные» типы событий: `{guidance, regulatory, fraud, accounting,
short_seller, litigation}`; `has_material` = уровень новостей ∈ {elevated, severe}
или есть событие материального типа.

| Флаг | Условие |
|---|---|
| **D1 stale_filing** | событие типа `guidance/accounting/regulatory` датировано **после** последнего 10-Q/10-K (компания не отчиталась о материальном событии) |
| **D3 active_ma_offer** | заголовок/саммари содержит одно из: `tender offer, to acquire, acquisition of, buyout, take private, merger agreement, agreed to buy, per share in cash, all-cash, to be acquired, takeover bid, go private` |
| **D4 unexplained_move** | доходность за 90 дней без материальных новостей и без M&A: \|ret\| > 25% → true; \|ret\| > 40% → `unexplained_move_severe` (влечёт `No Decision`) |

Возвращается: `{stale_filing, active_ma_offer, unexplained_move,
unexplained_move_severe, return_90d (доля, 3 зн.), news_risk_level}`.

## 4.8. Выход decision-блока

```json
{
  "total_score": 62.3,
  "verdict": "Hold",
  "confidence_pct": 60,
  "time_horizon": "3-5 years",
  "component_scores": {
    "business_quality": 82.0, "financial_strength": 92.0,
    "growth": 65.0, "valuation": 50.0, "risk": 60.0
  },
  "mispricing_type": "fairly_valued",
  "self_critique": {"bear_case": "...", "missed_risks": ["..."], "assessment": "caution"}
}
```

`time_horizon` берётся из risk-агента (`6-12 months | 1-2 years | 3-5 years | >5 years`),
дефолт `3-5 years`.

## 4.9. Dividend-пайплайн (вторая вкладка; сокращённо)

Тот же паттерн: `data_fetch → financial → cashflow (FCF coverage) → quality (LLM)
→ risk (LLM) → valuation (LLM) → portfolio (LLM) → decision`. Специфичные блоки
результата: `dividend_quality{dividend_type (6 типов), payout_ratio,
payout_sustainability, yield_trap_flag}`, `cashflow_analysis{avg_fcf_coverage,
fcf_trend, fcf_positive_years}`, `dividend_risk{cut_risk_pct (≤15 зелёный /
≤40 жёлтый / иначе красный), yield_trap_probability, primary_risk_type}`,
`dividend_valuation{yield_on_cost_3y/5y, expected_dps_growth_rate,
total_return_estimate}`, `portfolio_guidance{portfolio_role (5 ролей),
suggested_allocation_pct, allocation_rationale}`. Вердикты: `Strong Income Buy /
Income Buy / Hold / Avoid`; `decision.forward_yield_3y` (YoC) и
`expected_total_return` показываются в баннере.
