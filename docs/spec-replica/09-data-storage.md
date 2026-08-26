# 09. Хранение данных и кэши

## 9.1. БД (SQLite, WAL)

Прагмы: `journal_mode=WAL, busy_timeout=30000, foreign_keys=ON,
cache_size=-4096, synchronous=NORMAL, temp_store=MEMORY`.

Схема ведётся **из одного источника** (pydantic/SQL-миграции); в оригинале схема
дублировалась в backend `schema.sql` и agents `shared/schema.py` — известная
техдолговая проблема, в реплике так не делать (`10`, §2).

```sql
-- Кэш результатов анализов (backend)
CREATE TABLE analysis_cache (
  cache_key      TEXT PRIMARY KEY,     -- sha256("<type>:" + sorted-JSON params)
  analysis_type  TEXT NOT NULL,        -- equity | dividend | scanner
  ticker         TEXT,
  params_json    TEXT NOT NULL,
  result_json    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL      -- фиксируется при записи, не продлевается
);

-- Задачи сканера (analytics)
CREATE TABLE equity_scans (
  id            TEXT PRIMARY KEY,      -- uuid4()[:8]
  scan_type     TEXT NOT NULL DEFAULT 'undervalued',
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK(status IN ('running','completed','failed')),
  params        TEXT NOT NULL DEFAULT '{}',
  progress      TEXT,                  -- JSON {universeSize, fetched, prescreened,
                                       --        total, analyzed, failed, phase}
  results       TEXT,                  -- JSON-массив строк (при completed)
  advisor       TEXT,                  -- LLM-саммари
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX idx_equity_scans_status ON equity_scans(status, created_at DESC);

-- Кросс-процессный лок анализа
CREATE TABLE analysis_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ticker TEXT, pid INTEGER, started_at INTEGER, expires_at INTEGER
);

-- Исходы вердиктов (для будущей калибровки)
CREATE TABLE analysis_outcomes (
  ticker TEXT NOT NULL, analyzed_at INTEGER NOT NULL,
  verdict TEXT, confidence REAL, total_score REAL,
  price_at_analysis REAL,
  price_7d REAL, price_30d REAL, correct_direction INTEGER  -- дополняет фоновая джоба
);

-- Ревизии forward EPS
CREATE TABLE eps_revision_history (
  ticker TEXT NOT NULL, forward_eps REAL, recorded_at TEXT,
  UNIQUE(ticker, recorded_at)
);

-- Кэш SEC EDGAR
CREATE TABLE sec_filing_cache (
  ticker TEXT PRIMARY KEY, cik TEXT, fetched_at INTEGER, data_json TEXT
);

-- Безрисковая ставка для WACC (пишет макро-джоба; опционально статик-конфиг)
CREATE TABLE macro_indicators (
  indicator_name TEXT, value REAL, release_date TEXT
);
```

## 9.2. Матрица кэшей

| Кэш | Ключ | TTL | Где пишется | Особенности |
|---|---|---|---|---|
| Результат анализа | sha256(type+params) | 1 ч | backend после успеха | не пишется при `agents_failed ≥ 2`; hit бесплатный; force инвалидирует |
| Результат скана | sha256("scanner:"+params) | 30 мин | backend | виртуальный id `cache_<key>` |
| SEC XBRL | ticker | 6 ч | analytics | 13F — 24 ч; «нет CIK» тоже кэшируется |
| Вселенная тикеров | stock_list | процесс | in-memory | кэш словаря на инстанс |
| quick-info прескрина | ticker | **новое: 12 ч** | analytics | см. `10`, §3 — в оригинале отсутствует |

## 9.3. Очистка

Периодическая джоба: `analysis_cache` — удаление просроченных; `equity_scans` —
удаление старше 7 дней; `analysis_outcomes` — оставить (маленькая и ценная);
`eps_revision_history` — компрессия до недельных точек старше года. После удалений —
`PRAGMA wal_checkpoint(TRUNCATE)`.

## 9.4. Источники данных — сводка и лимиты

| Источник | Что берём | Лимиты/правила |
|---|---|---|
| yfinance | инфо, отчётность 10 лет, дивиденды, опционы, short, календарь, новости | неофициальный API: 429 → пауза 60 c глобально; ≤2–4 параллельных запроса; ретраи ×2 |
| SEC EDGAR | XBRL companyconcept, submissions, Form 4, 8-K, 13F, 10-K текст | UA-заголовок обязателен; 0.15 c между запросами; кэш 6/24 ч |
| NewsAPI | негативные новости | опционален (ключ); окно 90 дней, ≤12 |
| FRED / макро | 10Y UST для rf | опционально; фоллбек 4.3% |
| LLM | см. `05` | таймаут 90 c, 2 ретрая, backoff 60 c на rate-limit |

Рекомендация: обернуть yfinance-слой провайдер-интерфейсом (`MarketDataProvider`),
чтобы позже подменить на Polygon/FMP без переписывания пайплайна.
