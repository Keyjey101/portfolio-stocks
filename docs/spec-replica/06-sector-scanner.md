# 06. Секторный сканер: анализ всех компаний сектора

Страница «Сканер сектора»: пользователь выбирает тип скана, сектор (или все),
фильтры и top-N → асинхронная задача → прогресс → таблица результатов + LLM-советник.
Клик по тикеру ведёт на страницу полного анализа (`02`).

## 6.1. Типы скана

| Тип | Что ищет | Пайплайн | LLM |
|---|---|---|---|
| `undervalued` (default) | Недооценённые качественные компании (FV + MoS) | 2 фазы: прескрин → глубокое обогащение | 2 вызова/тикер (business, valuation-нарратив) + news + advisor |
| `dividend` | Дивидендные кандидаты (yield, payout, качество) | 1 фаза: только прескрин по quick-info | только advisor |

## 6.2. Вселенная тикеров

- **Курируемый список** (default, ~770 тикеров, 11 секторных корзин: technology,
  healthcare, financials, consumer_discretionary, consumer_staples, industrials,
  energy, materials, utilities, real_estate, communication_services) — статический
  файл в репо, обновляется вручную;
- `russell2000` — JSON-снимок индекса (~2000).

Секторная фильтрация выполняется **после** быстрого fetch'а по точной строке
`info["sector"]` (значения yfinance: `Technology, Healthcare, Consumer Cyclical,
Consumer Defensive, Industrials, Basic Materials, Energy, Utilities,
Communication Services, Financial Services, Real Estate`). Для undervalued-скана
в UI секторы Financial Services / Real Estate скрыты (DCF-методика хуже применима);
для dividend — доступны.

## 6.3. Фильтры (параметры задачи)

| Параметр | Значения | Правило |
|---|---|---|
| `sector` | `null` = все, либо строка сектора | равенство `info.sector` |
| `marketCapTier` | `all / micro / mid / large` | min cap: 0 / $300M / $2B / $10B |
| `volumeTier` | `all / low / medium / high` | min объём: 0 / 100K / 500K / 1M |
| `topN` | 10 / 20 / 30 / 50 (default 20) | размер итоговой выдачи |
| `stockList` | `null / russell2000` | выбор вселенной |
| `force` | bool | игнорировать кэш бэкенда |

Доп. жёсткие условия: undervalued → `pe_trailing ≤ 80`; dividend →
`dividend_yield ≥ 0.005` и `payout_ratio ≤ 1.5`.

## 6.4. Фаза 1 — прескрин

`data_agent.fetch_quick(ticker)`: двухступенчато — `fast_info` (cap, объём, цена,
quote_type), затем `.info` (sector, PE, ROE, yield). Конкурентно: батчи по 50
(dividend 150), `ThreadPoolExecutor(max_workers=2)`; yfinance 429 → глобальная
пауза 60 c, тикер пропускается; `gc.collect()` между батчами.

**Прескрин-скор** (база 50, clamp 0–100):

*undervalued:*
- P/E: `<0` −5; `<5` −5 (подозрительно дёшево); `<12` +18; `<18` +10; `<25` +4; `<40` −5; `<60` −12; `≥60` −20
- fwd/trail P/E: `>1.3` −12; `>1.1` −6; `<0.85` +8; `<0.95` +4
- P/B: `0 < pb < 1.5` +10; `< 3` +4
- ROE: `>0.20` +12; `>0.12` +7; `<0` −12
- рост выручки: `>0.15` +10; `>0.05` +5; `<−0.05` −8
- маржа: `>0.15` +8; `>0.05` +4; `<0` −10
- beta 0.5–1.3: +3

*dividend:*
- yield: 2.5–6% +22; 6–9% +12; >12% −8
- payout: 15–55% +15; ≤75% +6; >90% −12
- ROE: >15% +10; >8% +5; <0 −10
- маржа: >12% +8; >0 +3
- beta < 0.9: +5

Сортировка по скору; пул фазы 2 = `min(topN + 10, passed)` для undervalued
(запас под MoS-постфильтр). У dividend-скана фазы 2 нет.

## 6.5. Фаза 2 — обогащение (undervalued, последовательно на тикер)

1. `data_agent.fetch` — полный датасет (см. `02`, §2.2).
2. `financial_agent.run` — метрики и скоры (см. `03`, §3.11).
3. `business_agent` (LLM) — moat, business_score.
4. `valuation_agent` = `intrinsic_value.compute` (см. `03` целиком) + LLM-нарратив.
   Отказ → чистый `intrinsic_value.compute` без нарратива.
5. Канонические MoS → score → вердикт скана:
   `MoS > 30` **STRONGLY UNDERVALUED**; `> 15` **MODERATELY UNDERVALUED**;
   `> −10` **FAIRLY VALUED**; `> −25` **MODERATELY OVERVALUED**; иначе **STRONGLY OVERVALUED**.
6. **Качество сектора** (`sector_quality`, 0–10): нефин. — база = business_score
   (фоллбек financial_strength); ROIC < 0 → кап 4.0; ROIC 20–100% и опер. маржа > 40%
   → флор 7.0. Финансовые (bank/insurer/capital_markets по кейвордам) —
   `5.0 + ROE-лестница (≥15% +2.5; ≥10% +1.0; <5% −1.5; <0 −2.5) + рост балансовой
   стоимости (≥8% +1.5; ≥3% +0.5; <0 −1.5)`, итог `0.6·rule + 0.4·business_score`.
7. **Пик маржи**: последняя опер. маржа ≥ медиана + 1.5σ (≥5 лет, до 8) и цикличная
   → `sector_quality − 2`, флаг `peak_margin_flag`.
8. **Санити-цепочка вердикта**: LLM-числа вне [5%, 1500%] цены → заменить
   формульной FV; якорь консенсуса — кап `dcf_base` на `min(target_mean·1.25,
   target_high, price·1.6)`; потолок собственного мультипликатора — обоснованный
   forward P/E от роста: `g≤0 → 14; <5% → 17; <10% → 20; <15% → 24; <20% → 28;
   else 30` (±поправка качества, clamp 10–32, никогда ниже текущего P/E) × forward
   (фоллбек trailing) EPS; после капов MoS/score/вердикт пересчитываются.
   Экстремальный разрыв (MoS > 50%): качество ≥ 7 → флаг `fair_value_review`,
   score кап 7; качество < 7 и нет подтверждения качеством (Piotroski ≥ 7 или
   ROIC ≥ 10%, тренды не падают, EPS чист) → `extreme_gap_warning` (value-trap), кап 6.
9. **Red flags** (чистые правила; финанс. компании пропускают FCF/Piotroski/левередж):
   отрицательный FCF (×2 веса), падающая выручка/маржи, NetDebt/EBITDA > 4 crit /
   > 3 warn, interest coverage < 2 crit / < 3 warn, Piotroski ≤ 3 crit / ≤ 5 warn,
   ROE < 0 crit (→ warn при искажённом GAAP и положительном fwd EPS), ROE < 5% warn,
   ROIC < 0 warn, payout > 90% warn, growth_score ≤ 2 warn, цикличная + падающие
   маржи warn. Выход `{critical, warnings, items ≤ 15}`.
10. **Поправки качества к прескрин-скор** (`total_score`, clamp 0–100):
    качество < 6 + падающая выручка → −25; качество ≤ 3 → −12; ROIC < 10% +
    падающая выручка (нефин.) → −15; высокоцикличная + падающие маржи → −12;
    обычная цикличная деградация → −8; цикличная на пике маржи → −12;
    качество ≥ 8 и MoS > 15% и чисто → +10.
11. **Value-trap**: MoS > 30% И (высокоцикличная с падающими маржами | падающая
    выручка + Piotroski ≤ 3 | ≥ 3 critical flags | extreme_gap_warning) →
    `value_trap_warning` + причина.

## 6.6. News radar сканера

Для всего обогащённого пула (workers = 3): `news_agent.fetch_negative_news` (см.
`02`, §2.4). **Демотация**: уровень `severe` или событие fraud/accounting/short_seller →
`valuation_score ≤ 2`, `total_score ≤ 45`, `news_quarantine`, вердикт
`"AVOID — recent material news"`; уровень `elevated` или событие `guidance` →
`valuation_score ≤ 5`, `total_score ≤ 65`, `news_caution`, STRONGLY UNDERVALUED →
`"MODERATELY UNDERVALUED (news caution)"`. Просадка ≥ 30% от 52w high без новостей →
флаг `unexplained_move`.

## 6.7. Постфильтр и ранжирование (undervalued)

Постфильтр: оставить пул с MoS > 5%, если таких ≥ `min(topN/2, 5)`; иначе MoS > −5%,
если ≥ `min(topN/4, 3)`; иначе весь пул.

```
combined  = total_score · 0.40 + (valuation_score / 9) · 100 · 0.60      # ключ сортировки ↓
scan_score = clamp(0, 99.9,
    combined · 0.92
  + clamp(−2, 2, MoS% · 0.03)
  + clamp(0, 1.5, ROIC% · 0.03)
  + clamp(0, 1.5, FCF yield% · 0.15))
rank = 1..topN после сортировки
```

Двойной учёт дешевизны (total_score уже содержит MoS-поправки + valuation_score
с весом 60%) — **осознанный** tilt «качество со скидкой»; не «чинить» без ретюнинга.

## 6.8. Dividend-скан (сокращённо)

Одна фаза: quick-info на всю вселенную (батчи 150, workers 2) → фильтры
(yield ≥ 0.5%, payout ≤ 1.5) → див. скор (лестницы выше) → top-N строк из
quick-info → advisor. Без глубокого fetch и без LLM на тикер.

## 6.9. Advisor (LLM-саммари скана)

Один вызов (≤600 токенов) по top-5 строкам: 3–4 абзаца на русском — что общего у
найденных компаний, на что смотреть, ключевые оговорки. **Кластерное
предупреждение** (при ≥ 6 результатах): один сектор ≥ max(4, 40%) результатов,
или топ-2 сектора ≥ 55%, или elevated/severe новости у ≥ max(3, 30%) → в начало
текста добавляется «⚠ Концентрация — …».

## 6.10. Прогресс задачи

Фазы: `prescreening → deep_analysis → news_radar → advisor`. Прогресс-JSON в БД
обновляется каждые 50 обработанных тикеров фазы 1 и
после каждого тикера фазы 2: `{universeSize, fetched, prescreened, total, analyzed,
failed, phase}`. Фронтенд считает % сам (см. `07`, §5).

## 6.11. Строка результата (undervalued; снake_case на Python, camelCase в API)

```
rank, ticker, name, sector, industry, current_price, market_cap,
drawdown_from_52w_high, total_score, prescreen_score, sector_quality,
quality_adj_reasons[], peak_margin_flag, verdict, dcf_base,
margin_of_safety_pct, valuation_score, business_score, moat_type, moat_score,
pe_trailing, pe_forward, pb, ev_ebitda, roe, profit_margin, revenue_growth,
beta, avg_roic, avg_roe, revenue_cagr_3y, revenue_cagr_5y, fcf_yield,
avg_debt_ebitda, avg_operating_margin, piotroski_f, cyclicality_tag,
red_flags_critical, red_flags_warnings, red_flags_items[],
financial_strength_score, valuation_narrative, extreme_gap_warning,
fair_value_review[, fair_value_review_reason], value_trap_warning[,
value_trap_reason], news_radar_level, news_radar_summary, news_radar_items[],
[news_quarantine, news_caution, unexplained_move], rank, scan_score
```

Маппинг бэкенда в camelCase для UI: `valuation{fairValueWeighted, marginOfSafety,
verdict}`, `scores{scanScore, qualityScore}`, `keyMetrics{peTrailing, evEbitda,
roic, revenueCAGR3yr, fcfYield, netDebtEbitda}`, `redFlags{critical, warnings,
items}`, `valueTrap{warning, reason}`, `newsRadar{level, summary, items}`.

**Колонки таблицы UI (undervalued)**: # · Ticker · Company · Sector · Price ·
Fair Value · MoS % · Verdict · Scan Score · Quality/10 · ROIC % · Rev CAGR % ·
P/E · FCF Yield % · Piotroski/9 · Red Flags (Nc/Nw, tooltip — список) · News badge
(severity сортируется severe=3…none=0, tooltip — саммари + датированные заголовки).
Подсветка строк STRONGLY/MODERATELY UNDERVALUED. Клиентская сортировка по любой
колонке (дефолт — scan_score ↓; nulls last; строки через `localeCompare('ru')`),
экспорт CSV в буфер обмена.

Тикер в строке — ссылка на `/stock-analysis?ticker=…` (полный анализ).
