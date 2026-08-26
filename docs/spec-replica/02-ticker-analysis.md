# 02. Пайплайн анализа отдельного тикера

Цель: за один прогон (1.5–4 мин) собрать данные из 5 источников, посчитать
справедливую стоимость детерминированно, получить LLM-нарративы и выдать
вердикт с уверенностью. Всё стримится по SSE с пошаговым прогрессом.

## 2.1. Последовательность шагов

`data_fetch` — фатальный шаг: при его отказе весь анализ отменяется с ошибкой.
Все остальные шаги деградируют мягко (см. колонку «Фоллбек»).

| # | SSE-шаг | Что делает | Фоллбек при сбое |
|---|---|---|---|
| 0 | `init` | автодетект пиров, если не переданы (`--peers`); захват `analysis_lock` | — |
| 1 | `data_fetch` | `data_agent.fetch(ticker)` — полный датасет yfinance + контекст новостей за 6 мес (≤10, по ≤300 символов) | **Fatal** → `{"step":"error",...}` |
| 2 | `sec_filing` | EDGAR: XBRL-метрики, Form 4, 8-K, 13F, MD&A 10-K (+1 LLM-саммари) | `{"data_available": false}` |
| 3 | `news_radar` | негативные новости + LLM-классификация; вычисляются event-флаги D1–D4 (см. `04`, §5) | `{"risk_level":"unknown","events":[],"summary":null}` |
| 4 | `financial` | чистая математика: CAGR'ы, маржи, ROIC/ROE, Piotroski, скоры 0–10 | нейтральный словарь (все скоры 5.0, Piotroski 5) |
| 5 | `business` | LLM: бизнес-модель, ров, тренды отрасли (1 retry при фоллбеке) | `_fallback: true`, скоры 5, тексты «Analysis temporarily unavailable» → `agents_failed += 1` |
| 6 | `valuation` | `intrinsic_value.compute` (детерминированно) + 1 LLM-нарратив; затем **канонический пересчёт MoS**: `mos = round((dcf_base − price)/price×100, 1)`, `valuation_score = margin_of_safety_score(mos)` | `{}` → `agents_failed += 1` (математика всё равно уже в датасете при частичном сбое) |
| 7 | `market_sentiment` | без LLM: short interest, опционы, earnings-даты | пустые структуры |
| 8 | `risk_analysis` | сравнение с пирами → LLM risk-агент (последовательно, ради памяти) | `_fallback: true` → `agents_failed += 1` |
| 9 | `decision` | скор, вердикт, уверенность, self-critique; запись вердикта в `analysis_outcomes` | нейтральный вердикт `Hold / 50 / 30%` → `agents_failed += 1` |
| — | `complete` | elapsed_seconds | — |
| — | `result` | полный JSON результата (см. `08`, §5) | — |

Каждый шаг эмитит кадр `{"step": ..., "status": "running"|"done", "data": {...}}`
(пейлоады `data` — в §2.7). Логи — в stderr, протокол — в stdout.

## 2.2. Данные: `data_agent.fetch(ticker)`

Источник — yfinance (`Ticker.info`, `.financials`, `.balance_sheet`, `.cashflow`,
`.dividends`, `.calendar`, `.earnings_history`, `.news`), 10 лет годовой отчётности,
свежие первыми. Ретраи: 2 доп. попытки, пауза 2 c; при HTTP 429 — глобальная пауза
60 c (общий флаг для всех потоков инстанса).

**meta**: `ticker, name, sector, industry, country, currency, exchange,
current_price, market_cap, enterprise_value, shares_outstanding, float_shares,
beta, 52w_high, 52w_low, avg_volume, description (longBusinessSummary, обрезается
до ~400 символов для промптов), financial_currency`.

**multiples**: `pe_trailing, pe_forward, pb, ps, peg, ev_ebitda, ev_revenue,
fcf_yield = free_cash_flow[0] / market_cap`.

**Годовые серии (10 лет, свежие первыми)**

- Income: `revenue, gross_profit, operating_income, net_income, ebitda, interest_expense`
- Balance: `total_assets, total_equity, total_debt, current_debt, cash_equivalents`
- Cash flow: `operating_cf, capex, dividends_paid`
- Производные по годам: `free_cash_flow = operating_cf + (capex or 0)`;
  `gross/operating/net/fcf_margin`; `roic = NI / (debt + equity − cash)`; `roe`
  (обнуляется при equity ≤ 0); `net_debt = debt − cash`; `debt_ebitda`;
  `interest_coverage = operating_income / |interest_expense|`; `fcf_conversion = FCF / NI`.

**Нормализация валюты (ADR/FX).** Если `financial_currency ≠ currency` — курс
`yf.Ticker("FROMTO=X")` (последняя цена, фоллбек — close за 5 дней; 1.0 при сбое).
Все абсолютные денежные ряды умножаются на курс; `ev_ebitda, ev_revenue, pb,
pe_trailing, pe_forward` пересчитываются от нормализованных значений.
Флаг `currency_normalized`.

**Sanity-флаги (`data_sanity_flags`)** — влияют на уверенность (см. `04`, §4):

- `gross_profit_implausible` — operating_income > 1.02 × gross_profit → gross_profit зануляется;
- `negative_book_equity` — total_equity[0] ≤ 0;
- `revenue_discontinuity` — компания с cap > $2B и |YoY revenue| > 100%;
- `currency_normalized`.

**dividend_data**: `yield` (доля; значение >1 трактуется как проценты и делится на 100),
`annual_dps, ex_date, payout_ratio, five_yr_avg_yield, history_annual` (10 лет).

**eps_data**: `trailing_eps, forward_eps, annual_earnings` (5 записей `{year, revenue, earnings}`).
`forward_eps` дополнительно пишется в `eps_revision_history` (для будущего трекинга ревизий).

**analyst**: `target_mean, target_high, target_low, recommendation, n_analysts,
eps_growth_next_year, eps_growth_next_5y, revenue_growth`.

## 2.3. SEC EDGAR (`sec_filing_agent`)

Base URL'ы: `https://efts.sec.gov/LATEST/search-index`, `https://data.sec.gov/submissions`,
`https://data.sec.gov/api/xbrl/companyconcept`, архивы. Обязательный заголовок
`User-Agent: <project>/(version) <contact@example.com>`; пауза 0.15 c между запросами;
httpx timeout 10 c. Кэш в таблице `sec_filing_cache` (TTL 6 ч XBRL / 24 ч 13F);
отрицательные результаты (CIK не найден, `data_available:false`) тоже кэшируются.

Поток:

1. `resolve_cik` — мапа `company_tickers.json`, фоллбек — поиск EFTS.
2. XBRL: лёгкие запросы **по одному концепту** (`companyconcept`), ~10 штук:
   `Revenues, NetIncomeLoss, EarningsPerShareBasic, LongTermDebt,
   ShortTermBorrowings, StockholdersEquity, OperatingIncomeLoss,
   NetCashProvidedByUsedInOperatingActivities, CapitalExpenditures` (+алиасы).
   Берутся только годовые факты (10-K/20-F, длительность 300–400 дней) → YoY.
3. `submissions` → даты последних 10-K / 10-Q.
4. Form 4 (инсайдеры, ≤10 за 90 дней, XML): коды P=покупка, S=продажа,
   value = shares × price. `activity_signal`: `heavy_selling` (продажи > 3× покупок),
   `buying_pressure` (покупки > 2× продаж), `elevated` (>5 сделок), `normal`, `none`.
5. 8-K события (180 дней, ≤5, классификация по item'ам).
6. 13F институционалы (180 дней, словарь примечательных фондов).
7. MD&A + Item 1A риски из 10-K (по 15 000 символов) → **один LLM-вызов**
   (512 токенов, temp 0.1) → `mda_summary, top_risks[3–5],
   filing_tone ∈ {positive, cautiously_optimistic, neutral, cautious, negative}`.
   Фоллбек без LLM: первые 500 символов MD&A, 5 длинных предложений рисков,
   tone по подсчёту слов.
8. (Опция, по умолчанию выкл.) XBRL-сравнение с пирами: ≤5 пиров × ~10 концептов,
   метрики `operating_margin, debt_to_equity, revenue_change_pct` + перцентиль цели.

Выход (сокращённо): `ticker, cik, data_available, revenue_change_pct,
net_income_change_pct, eps_change_pct, debt_to_equity, debt_change_pct,
operating_margin, margin_change, free_cash_flow, fcf_change_pct, last_10k_date,
last_10q_date, recent_8k_events[{date, description, event_type, icon}],
recent_form4{buy_count, sell_count, activity_signal, total_buy_value_usd,
total_sell_value_usd, largest_single_transaction_usd}, form4_filings[:5],
xbrl_metrics, quarterly_series, institutional_changes, mda_summary, top_risks,
filing_tone, filing_staleness_warning (если 10-K старше 15 месяцев)`.

## 2.4. News radar (`news_agent.fetch_negative_news`)

Источники: заголовки yfinance + NewsAPI `/v2/everything` (если есть ключ) с запросом:

```
'"<Company Name>" AND (fraud OR lawsuit OR "class action" OR investigation OR probe
OR "short seller" OR "short report" OR SEC OR subpoena OR recall OR downgrade OR
"guidance cut" OR restatement OR default OR bankruptcy OR scandal OR resign OR
layoffs OR delisting)'
```

Окно 90 дней, ≤12 статей, дедуп по нормализованному заголовку. Затем **один
LLM-вызов** (temp 0.2, 500 токенов) → `{"risk_level": none|watch|elevated|severe|unknown,
"events": [{type ∈ fraud|litigation|regulatory|short_seller|guidance|accounting|
management|other, headline, date, summary}] (≤5), "summary"}`.
Гард: уровень elevated/severe без событий → понижается до `watch`.

## 2.5. Market sentiment (без LLM)

- **short_interest**: `short_pct_of_float = sharesShort / floatShares × 100`,
  `short_ratio = sharesShort / avgVolume`; сигнал: >30% — потенцил шорт-сквиза,
  >20% — high, >10% — moderate, иначе low.
- **options_sentiment** (ближайший экспири): `put_call_ratio` (объём), `put_call_ratio_oi`
  (OI), `implied_volatility` = медиана call IV по 2 ближайшим экспири × 100 (сэмплы
  капятся <200%); сигнал PCR: >1.2 bearish, <0.7 bullish, иначе neutral.
- **earnings_data**: `next_earnings_date, days_until_earnings, last_4_surprises,
  avg_eps_surprise_pct = (actual − est)/|est| × 100`.

## 2.6. Peers (сравнение с аналогами)

- Выбор: курируемый словарь `{тикер: [пиры]}` (~150 mega/large caps, 2–4 пира);
  фоллбек — группировка по 9 секторам, 4 ближайших пира; ручной ввод `--peers` приоритетнее.
- Метрики: последовательный (ради памяти) `yfinance .info` по ≤4 пирам:
  `ticker, name, market_cap, current_price, pe_trailing, pe_forward, ev_ebitda,
  revenue_growth, roe, operating_margin`; пиры со всеми None-метриками выбрасываются.
- В детерминированную оценку пиры **не входят** (используются обоснованные мультипликаторы
  от роста, см. `03`); пиры — контекст LLM-нарратива и таблица в UI.

## 2.7. SSE-пейлоады по шагам (для прогресс-карточек)

| Шаг | `data` |
|---|---|
| `data_fetch/done` | `{"name": "Apple Inc."}` |
| `sec_filing/done` | `{"revenue_change", "margin", "insider_signal", "8k_events": <int>}` |
| `news_radar/done` | `{"level", "stale": bool, "ma": bool, "unexplained": bool}` |
| `financial/done` | `{"growth_score"}` |
| `business/done` | `{"moat", "score"}` |
| `valuation/done` | `{"base", "mos"}` |
| `market_sentiment/done` | `{"short_signal", "options_signal", "days_to_earnings"}` |
| `risk_analysis/done` | `{"mispricing", "risk_score"}` |
| `decision/done` | `{"verdict", "score", "confidence"}` |
| `complete/done` | `{"elapsed_seconds"}` |

Финальные кадры: `{"step":"result","status":"done","data": <полный результат>}`;
при фатале `{"step":"error","status":"failed","data":{"error": msg, "ticker": ...}}` + exit 1.
Прокси добавляет в `result`-кадр мету кэша `_cache: {hit, created_at, expires_at}`.

## 2.8. Запись в БД по завершении

`analysis_outcomes(ticker, analyzed_at, verdict, confidence, total_score,
price_at_analysis)` — фоновой джобой позже дописываются `price_7d, price_30d,
correct_direction` (Buy/Strong Buy и цена выросла; Avoid и упала; Hold и |Δ| < 10%).
Используется для будущей калибровки весов. Плюс `eps_revision_history` при каждом fetch.
