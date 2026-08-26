# 01. Архитектура

## 1.1. Компоненты и потоки данных

```
┌────────────────────────────────────────────────────────────────────────┐
│ Frontend (SPA нового сайта)                                             │
│  · Страница «Анализ акции»  ── SSE ──┐                                  │
│  · Страница «Сканер сектора» ── poll ─┤                                 │
└───────────────────────────────────────┼────────────────────────────────┘
                                        │ /api/*
┌───────────────────────────────────────▼────────────────────────────────┐
│ Backend API (Node.js + Express + TypeScript)                            │
│  · SSE-прокси анализа (кэш → кредиты → стрим из Python)                 │
│  · Сканер: старт задачи + поллинг статуса + маппинг полей               │
│  · Кэш результатов (SQLite), кредиты (опц.), rate limits                │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTP / SSE (внутренняя сеть)
┌───────────────▼────────────────────────────────────────────────────────┐
│ Analytics Engine (Python 3.11 + FastAPI)                                │
│  · /analyze/{ticker}[/stream]  → subprocess: orchestrator (пайплайн 1)  │
│  · /scan, /scan/{id}/status|results → subprocess: scanner (пайплайн 2)  │
│  · Прогресс/результаты пишутся в SQLite, обе стороны их читают          │
└──────┬──────────────┬───────────────┬───────────────┬──────────────────┘
       │              │               │               │
  yfinance       SEC EDGAR        NewsAPI/RSS      LLM (OpenAI-совместимый
  (котировки,    (XBRL, Form4,    (негативные      API; в оригинале GLM-5,
  отчётность,    8-K, 13F,        новости по       годится любой strong-модель
  инфо)          10-K MD&A)       тикеру)          с tool/JSON-вызовом)
```

Связь **только через БД и HTTP-прокси** между frontend и Python; агенты между собой
не общаются (SQLite как общая шина состояния).

## 1.2. Изоляция тяжёлых задач (обязательно)

Оба пайплайна запускаются **отдельными subprocess'ами**, а не в процессе FastAPI:

- анализ тикера: `python -m equity.orchestrator --ticker AAPL --lang ru --stream`;
- сканер: `python -m equity.scanner --scan-id <id> --params '<json>'`.

Причины: (а) пик памяти на обогащении тикера — OOM убивает subprocess, а не API-сервер
(в оригинале дополнительно `oom_score_adj=1000` на POSIX); (б) чистый `gc` между
тикерами; (в) код возврата `-9/137` трактуется как «не хватило памяти» и маппится в
понятную ошибку.

FastAPI лишь: принимает запрос → создаёт запись задачи в БД (статус `running`) →
стартует subprocess в фоне → отдаёт `scan_id`/стримит stdout. Статус и результаты
читаются из БД, поэтому поллинг никогда не ловит 404 у запущенной задачи.

## 1.3. Взаимные блокировки

| Механизм | Реализация | Параметры |
|---|---|---|
| Кросс-процессный лок на анализ тикера | таблица `analysis_lock` (одна строка: ticker, pid, started_at, expires_at) | TTL 420 c; захват перед запуском, освобождение в `finally` |
| Приоритет интерактивного над фоновым | фоновые задачи при активном скане ждут (поллинг 5 c) | макс. ожидание 600 c; скан старше 5400 c считается зависшим и игнорируется |

Одновременный анализ одного тикера запрещён; разные тикеры — допускается (ограничить 1–2 в конфиге).

## 1.4. Тайминги и лимиты (сводная таблица)

| Параметр | Значение | Где |
|---|---|---|
| Полный анализ тикера, серверный кап | 600 c (env `EQUITY_ANALYSIS_TIMEOUT`) | Python |
| Стрим-таймаут прокси | 630 c | backend |
| Plain-JSON анализ (без SSE) | 300 c | backend |
| Heartbeat SSE | 1 c (`: ka`), если от Python нет строк 15 c | обе стороны |
| Scan: stale-порог | 5400 c | Python |
| Scan: оценка длительности | `top_n × 30` c | Python |
| Поллинг статуса скана фронтендом | 2 c | frontend |
| Rate limit: тяжёлые эндпоинты | 5 req/min (анализ, запуск скана) | backend |
| Rate limit: поллинг скана | 120 req/min | backend |
| Кэш результата анализа | 1 ч (fixed при записи, не обновляется на hit) | backend |
| Кэш результата скана | 30 мин | backend |
| Кэш SEC XBRL | 6 ч; 13F — 24 ч; «CIK не найден» — тоже кэшируется | Python |
| yfinance 429 | глобальная пауза 60 c для всех потоков | Python |
| Пауза между запросами EDGAR | 0.15 c; httpx timeout 10 c | Python |

## 1.5. Рекомендуемый стек

Соответствует оригиналу (проверено в бою); замены допустимы при сохранении контрактов из `08`.

| Слой | Оригинал | Допустимая замена |
|---|---|---|
| Frontend | Vue 3 + TS + Vite + Pinia + vue-i18n | React/Next: SSE-клиент и стор переносятся 1:1 (см. `07`) |
| Backend | Node 22 + Express + better-sqlite3 | Nest/Fastify; SQLite можно на Postgres |
| Analytics | Python 3.11 + FastAPI + pydantic v2 + httpx + yfinance + tenacity | — |
| LLM | OpenAI-совместимый API (GLM-5), tool-calling или строгий JSON | любой провайдер со structured output |
| БД | SQLite (WAL) | Postgres при мультисервере |

Env-переменные (минимум):

```
ZAI_API_KEY=…              # ключ LLM
ZAI_BASE_URL=https://…     # OpenAI-совместимый endpoint
ZAI_MODEL=glm-5            # модель
AGENTS_API_URL=http://localhost:5000
NEWSAPI_KEY=               # опционально, без него работают RSS/Yahoo
DB_PATH=./data/analytics.db
EQUITY_ANALYSIS_TIMEOUT=600
SCANNER_PRESCREEN_MAX_WORKERS=2
```

## 1.6. Карта модулей для реализации

```
analytics/
  shared/          # llm_client, db, retry, semaphore, schema
  equity/
    data_agent.py        # yfinance: fetch (полный) и fetch_quick (прескрин)
    financial_agent.py   # чистая математика метрик и скоров (без LLM)
    intrinsic_value.py   # детерминированный движок оценки  ← ядро
    business_agent.py    # LLM
    valuation_agent.py   # intrinsic_value + LLM-нарратив
    risk_agent.py        # LLM
    news_agent.py        # негативные новости + LLM-классификация
    sec_filing_agent.py  # EDGAR
    market_sentiment.py  # short interest / опционы / earnings (без LLM)
    decision_engine.py   # скор, вердикт, уверенность, self-critique
    orchestrator.py      # последовательность шагов + SSE
    scanner.py           # секторный сканер (value)
    dividend/scanner.py  # дивидендный сканер
    universe.py          # вселенные тикеров
  api_server.py          # FastAPI: /analyze, /scan
backend/                 # Express: прокси, кэш, кредиты (опц.)
frontend/                # страницы «Анализ акции» и «Сканер сектора»
```
