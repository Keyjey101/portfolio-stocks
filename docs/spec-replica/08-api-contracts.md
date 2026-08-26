# 08. Контракты API (с примерами)

Два слоя: **Backend (Express, :3001)** — внешний, с кэшем/кредитами/лимитами; и
**Analytics (FastAPI, :5000)** — внутренний. Формат ответов backend:
`{ "data": …, "timestamp": <unix> }`; ошибки: `{ "error": "code", …детали }`.
Кейс полей: Python — snake_case, внешний API — camelCase (маппинг в backend).

## 8.1. Анализ тикера

### `GET /api/equity/analyze/:ticker/stream` (SSE)
Query: `lang=ru` (в реплике фиксируется ru), `peers=MSFT,GOOGL` (опц.), `force=true` (опц.).
Лимиты: auth + 5 req/min. Заголовки: `text/event-stream, no-cache, keep-alive,
X-Accel-Buffering: no`.

Логика прокси (порядок важен):

1. Ключ кэша = `sha256("equity:" + JSON({ticker, peers, lang} с сортировкой ключей))`.
   HIT и не force → **один** кадр `result` с `_cache` и закрытие (бесплатно).
2. `force=true` → инвалидация кэша.
3. Списание кредитов: 10 (анализ) / 5 (force). Не хватает → кадр `error`
   `{error:"insufficient_credits", credits_required, credits_available}` (HTTP-вариант: 402).
4. Проксирование SSE из `:5000/analyze/:ticker/stream` (таймаут 630 c), heartbeat
   `: ka` каждые 1 c при простое, все записи в try/catch (обрыв клиента не роняет анализ).
5. Расчёт по факту (`settled` — один раз): error/нет result-кадра → полный возврат;
   `agents_failed ≥ 2` → полный возврат и **не кэшировать**; `agents_failed = 1` →
   возврат 50%; успех → запись в кэш (TTL 1 ч).

### `GET /api/equity/analyze/:ticker/result`
Восстановление после обрыва: только чтение кэша. HIT → `{step:"result",
status:"done", data, _cache}`; MISS → **204** (никогда не стартует прогон и не списывает).

### `GET /api/equity/analyze/:ticker` — plain JSON (300 c), та же логика кэша/кредитов без SSE.

Аналогичная тройка для `/api/equity/dividend/analyze/...` (кэш-ключ без peers).

### Кадры SSE (примеры)

```
data: {"step":"data_fetch","status":"running","data":{}}
data: {"step":"data_fetch","status":"done","data":{"name":"Apple Inc."}}
data: {"step":"sec_filing","status":"done","data":{"revenue_change":2.1,"margin":31.7,
       "insider_signal":"heavy_selling","8k_events":3}}
data: {"step":"valuation","status":"done","data":{"base":195.4,"mos":-15.9}}
data: {"step":"decision","status":"done","data":{"verdict":"Hold","score":62.3,"confidence":60}}
data: {"step":"result","status":"done","data":{ …см. §8.2… },
       "_cache":{"hit":false,"created_at":1755900000,"expires_at":1755903600}}
```

### Полный результат (сокращённый, ключевые блоки)

```jsonc
{
  "ticker": "AAPL", "name": "Apple Inc.", "sector": "Technology",
  "industry": "Consumer Electronics", "current_price": 232.5,
  "market_cap": 3.5e12, "enterprise_value": 3.52e12, "currency": "USD", "beta": 1.24,
  "multiples": {"pe_trailing": 35.2, "pe_forward": 30.1, "pb": 48.0, "ps": 8.9,
                "peg": 2.5, "ev_ebitda": 26.3, "ev_revenue": 8.7, "fcf_yield": 0.0096},
  "analyst": {"target_mean": 250.0, "target_high": 300.0, "target_low": 200.0,
              "recommendation": "buy", "n_analysts": 41,
              "eps_growth_next_year": 0.12, "eps_growth_next_5y": 0.09, "revenue_growth": 0.06},
  "financial_metrics": {"revenue_cagr_3y": 0.071, "revenue_cagr_5y": 0.078,
    "revenue_trend": "improving", "margin_trend": "stable",
    "avg_gross_margin": 0.463, "avg_operating_margin": 0.312, "avg_roic": 0.56,
    "avg_roe": 1.6, "fcf_positive_years": 4, "fcf_available_years": 4,
    "avg_debt_ebitda": 0.5, "avg_interest_coverage": 30.0, "piotroski_f": 6,
    "is_cyclical": false, "is_highly_cyclical": false, "cyclicality_tag": null,
    "growth_score": 6.5, "profitability_score": 9.5, "efficiency_score": 9.5,
    "cashflow_score": 9.0, "financial_strength_score": 8.7,
    "trailing_eps": 6.6, "forward_eps": 7.7, "eps_quality_flag": "normal",
    "accruals_ratio": -0.02, "debt_stress_flag": false, "data_sanity_flags": []},
  "business_analysis": {"business_model": "…", "revenue_type": "recurring",
    "moat_type": "brand", "moat_description": "…", "moat_score": 8,
    "industry_trend": "growing", "industry_cyclicality": "secular",
    "industry_score": 7, "business_score": 8, "key_insights": ["…"], "concerns": ["…"]},
  "valuation": {"dcf_base": 195.4, "dcf_bear": 155.2, "dcf_bull": 248.9,
    "expected_value": 198.8, "scenario_probabilities": {"bear": 0.25, "base": 0.5, "bull": 0.25},
    "valuation_methods": [{"name": "dcf", "value": 210.5, "weight": 0.31}],
    "analyst_target": 250.0, "analyst_target_pv": 237.4, "wacc": 0.0912,
    "cost_of_equity": 0.0955, "growth_used": 0.09, "terminal_growth": 0.021,
    "data_quality": "ok", "dispersion": 0.21, "dispersion_flag": false,
    "method_spread_ratio": 1.4, "low_reliability": false, "asset_light": true,
    "no_estimate": false, "range_low": 140.0, "range_high": 260.0,
    "supported_value": 120.3, "priced_in": 112.2, "valuation_framing": "…",
    "valuation_floor": 120.3, "earnings_power_value": 120.3,
    "margin_of_safety_pct": -15.9, "valuation_score": 3,
    "valuation_narrative": "…(рус)…", "relative_assessment": "…(рус)…",
    "is_cyclically_adjusted": false},
  "risk_thesis": {"why_cheap_or_expensive": "…(рус)…",
    "is_temporary_or_structural": "fairly_valued", "what_market_misses": "…",
    "mispricing_type": "fairly_valued", "catalysts": ["…"], "key_risks": ["…"],
    "time_horizon": "3-5 years", "thesis_summary": "…", "risk_score": 4,
    "sec_filing_assessment": "…"},
  "decision": {"total_score": 62.3, "verdict": "Hold", "confidence_pct": 60,
    "time_horizon": "3-5 years",
    "component_scores": {"business_quality": 82.0, "financial_strength": 92.0,
                         "growth": 65.0, "valuation": 30.0, "risk": 60.0},
    "mispricing_type": "fairly_valued",
    "self_critique": {"bear_case": "…", "missed_risks": ["…"], "assessment": "caution"}},
  "news_radar": {"risk_level": "none", "events": [], "summary": null},
  "event_flags": {"stale_filing": false, "active_ma_offer": false,
                  "unexplained_move": false, "unexplained_move_severe": false,
                  "return_90d": 0.052, "news_risk_level": "none"},
  "sec_filing_data": {"data_available": true, "last_10k_date": "2025-11-01",
    "last_10q_date": "2026-05-01", "operating_margin": 31.7, "margin_change": 0.5,
    "revenue_change_pct": 2.0, "debt_to_equity": 1.5, "debt_change_pct": -3.0,
    "recent_8k_events": [{"date": "2026-06-10", "description": "…",
                          "event_type": "earnings", "icon": "earnings"}],
    "recent_form4": {"buy_count": 2, "sell_count": 12,
                     "activity_signal": "heavy_selling",
                     "total_buy_value_usd": 2e6, "total_sell_value_usd": 4.5e7,
                     "largest_single_transaction_usd": 8e6},
    "quarterly_series": {"Revenues": [{"val": 1e11, "end": "2026-06-30", "form": "10-Q"}]},
    "institutional_changes": {"notable_activity": "…", "recent_filings_count": 40},
    "mda_summary": "…", "top_risks": ["…"], "filing_tone": "neutral",
    "filing_staleness_warning": null},
  "market_sentiment": {"short_interest": {"short_pct_of_float": 0.8,
      "short_ratio": 0.7, "signal": "low_short_interest"},
    "options_sentiment": {"put_call_ratio": 0.65, "put_call_ratio_oi": 0.7,
      "implied_volatility": 24.5, "nearest_expiry": "2026-08-29", "signal": "bullish"},
    "earnings_data": {"next_earnings_date": "2026-10-30", "days_until_earnings": 67,
      "avg_eps_surprise_pct": 4.2, "last_4_surprises": [3.1, 6.2, 2.0, 5.5]},
    "sentiment_interpretation": "…"},
  "series": {"revenue": [], "free_cash_flow": [], "operating_margin": [],
             "roic": [], "net_income": []},
  "peers": ["MSFT", "GOOGL", "META", "AMZN"],
  "peers_comparison": [{"ticker": "MSFT", "name": "Microsoft", "market_cap": 3.1e12,
    "current_price": 420.0, "pe_trailing": 33.0, "pe_forward": 28.0,
    "ev_ebitda": 24.0, "revenue_growth": 0.14, "roe": 0.38, "operating_margin": 0.44}],
  "agents_failed": 0, "analyzed_at": 1755900000, "elapsed_seconds": 145.6
}
```

## 8.2. Analytics API (:5000, внутренний)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/analyze/{ticker}?peers=&lang=ru` | полный JSON `{data, timestamp}` (subprocess, stdout) |
| GET | `/analyze/{ticker}/stream` | SSE-версия (JSON-lines stdout → `data:` кадры) |
| GET | `/dividend/analyze/{ticker}[/stream]` | див. пайплайн |
| POST | `/scan?top_n=&sector=&market_cap_tier=&volume_tier=&scan_type=&stock_list=` | старт скана (в реплике — JSON body, см. `10`, §5) |
| GET | `/scan/{id}/status` | статус+прогресс |
| GET | `/scan/{id}/results` | результаты (только completed, иначе 400) |

Коды: subprocess `-9/137` → 503 OOM; таймаут → 504; прочее → 500 c `{"error"}`.

### `POST /scan` → `202`

```json
{ "scan_id": "ab12cd34", "scan_type": "undervalued", "estimated_seconds": 600 }
```

Строка задачи в `equity_scans` создаётся **до** возврата (поллинг не ловит 404).

### `GET /scan/{id}/status` → `200`

```json
{ "scan_id": "ab12cd34", "status": "running",
  "params": {"topN": 20, "sector": "Technology", "marketCapTier": "mid",
             "volumeTier": null, "scanType": "undervalued", "stockList": null},
  "progress": {"universeSize": 770, "fetched": 400, "prescreened": 120,
               "total": 30, "analyzed": 12, "failed": 1, "phase": "deep_analysis"},
  "error_message": null }
```

## 8.3. Сканер — внешний API (backend)

### `POST /api/equity/scan` (auth, 5/min) → `202`

```json
// запрос
{ "topN": 20, "scanType": "undervalued", "sector": "Technology",
  "marketCapTier": "mid", "volumeTier": "all", "stockList": null, "force": false }
// ответ — свежий запуск
{ "data": {"scanId": "ab12cd34", "scanType": "undervalued", "estimatedSeconds": 600},
  "timestamp": 1755900000 }
// ответ — кэш-хит (бесплатно): scanId = "cache_<sha256>"
```

Кэш-ключ: `sha256("scanner:" + JSON({scanType, topN, sector?, marketCapTier?,
volumeTier?, stockList?} сортированные))`; TTL 30 мин, fixed при записи.
Стоимость: `5 + 2 × topN` (topN=20 → 45); force: `5 + (5 + 2N)`; списание до
старта, возврат только при не-старте. 402 при нехватке.

### `GET /api/equity/scan/:id/status` (120/min, без auth) → `200`

```json
{ "data": { "scanId": "ab12cd34", "status": "completed",
  "progress": {"phase": "advisor", "universeSize": 770, "fetched": 770,
               "prescreened": 118, "total": 30, "analyzed": 30, "failed": 0} },
  "timestamp": 1755900600 }
```

### `GET /api/equity/scan/:id/results` → `200` (строка результата — `06`, §6.12)

```json
{ "data": {
    "scanId": "ab12cd34",
    "results": [{
      "rank": 1, "ticker": "XYZ", "name": "Example Corp", "sector": "Technology",
      "currentPrice": 42.1,
      "valuation": {"fairValueWeighted": 61.3, "marginOfSafety": 45.6,
                    "verdict": "STRONGLY UNDERVALUED"},
      "scores": {"scanScore": 78.4, "qualityScore": 7.5},
      "keyMetrics": {"peTrailing": 11.2, "evEbitda": 8.1, "roic": 0.14,
                     "revenueCAGR3yr": 0.09, "fcfYield": 0.07, "netDebtEbitda": 0.8},
      "piotroskiF": 7, "moatType": "cost_advantage", "moatScore": 7,
      "redFlags": {"critical": 0, "warnings": 1, "items": ["Piotroski 5/9"]},
      "valueTrap": {"warning": false, "reason": null},
      "newsRadar": {"level": "none", "summary": null, "items": []}
    }],
    "stats": {"analyzed": 30, "undervalued": 12, "returnedTopN": 20, "failed": 0}
  },
  "advisor": "…(русский текст LLM)…",
  "_cache": {"hit": false, "created_at": 1755900600, "expires_at": 1755902400} }
```

`GET /api/equity/scan/:id/progress` (SSE: кадры каждые 3 c + heartbeats) —
существует, но фронтенд использует 2-секундный поллинг `/status`.

## 8.4. Кредиты (опциональный модуль)

`spendCredits(userId, amount, type, metadata)` — транзакционно (баланс +ledger
`credit_transactions`). Стоимости: анализ тикера 10, див. анализ 10, force 5,
сканер `5 + 2×topN`. Возвраты: полный при сбое/≥2 упавших агентах/не-старте;
50% при 1 упавшем. `settled`-флаг гарантирует ровно одно терминальное действие.
Если монетизация не нужна — модуль вырождается в no-op, все контракты выше не меняются.

## 8.5. Коды ошибок (единый словарь)

| Код | HTTP | Смысл |
|---|---|---|
| `insufficient_credits` | 402 | не хватает кредитов (+required/available) |
| `rate_limited` | 429 | лимит запросов |
| `analysis_failed` | 500 | общий сбой анализа |
| `analysis_timeout` | 504 | превышен серверный кап 600 c |
| `oom_killed` | 503 | subprocess убит по памяти |
| `scan_not_found` | 404 | неизвестный scan_id |
| `scan_not_ready` | 400 | results до завершения |
| `data_fetch_failed` | 500 | yfinance не отдал данные (фатальный шаг) |
