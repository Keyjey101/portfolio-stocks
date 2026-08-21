# Часть C3 — LLM-агенты (#2 детектор, #3 фальсификации, #10 комитет): план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans to implement this plan task-by-task.

**Goal:** детектор слома тезиса (остаток 2.5σ → новости+EDGAR → GLM-вердикт), реестр фальсификаций (генерация + ежеквартальная проверка), комитет агентов с вероятностными прогнозами и Brier-калибровкой.

**Architecture:** `src/llm.js` (z.ai-клиент, JSON-схемы, ретраи, лог бюджета), `src/news.js` (Yahoo RSS), `src/edgar.js` (тикер→CIK, филлинги), подсистемы в `src/lab/{detector,falsify,committee}.js`; append-only логи `data/recs.jsonl`, `data/predictions.jsonl`, реестр `data/falsifications.json`; UI-секции и POST-роуты в `/lab`; каденции «экономно» через планировщик.

**Spec:** `docs/superpowers/specs/2026-08-21-part-c-lab-design.md`, раздел 6.

## Global Constraints

- Node ≥ 18.14, без npm-зависимостей; ключи из `.env` (env-переменная приоритетнее).
- Каждое LLM-обращение логируется в `data/llm-log.jsonl` (бюджет-контроль).
- Говорящие имена: `chat(messages, {schema, task, fetchImpl})` → валидный объект; ≤2 ретраев.
- Детектор: cooldown 7 дней на тикер; порог |r| > 2.5σ.
- Комитет: еженедельно; события — машинно-разрешимая грамматика; Brier по ролям; консенсус softmax(−Brier).
- Все append-only логи — JSONL с `ts`.

## Tasks

### T1: `src/llm.js` — клиент z.ai
`chat(messages, {schema, task, t, temperature=0.2, fetchImpl})`: POST `{base}/chat/completions` (OpenAI-совместимый), ответ чистится от ```-заборов, JSON.parse; валидация схемой `{field: 'string'|'number'|'enum:[...]'|'array'|'boolean'}`; при провале — ретрай с текстом ошибки (≤2); лог `{ts, task, t, model, ok, retries}`. Тесты: валидный с первого раза; невалидный → ретрай → валидный; три провала → throw; лог записан.

### T2: `src/news.js` — заголовки Yahoo RSS
`parseRss(xml) → [{title, link, date}]` (regex, CDATA-aware); `fetchHeadlines(t, fetchImpl)` — `feeds.finance.yahoo.com/rss/2.0/headline?s=`, ≤12 свежих. Тест на фикстуре.

### T3: `src/edgar.js` — тикер→CIK + филлинги
`parseTickerMap(json) → {TICKER: cik10}`; `parseFilings(json, {forms, limit}) → [{form, date, url}]`; `edgarRecent(t)` — кэш карты 7 дн (`data/cache/edgar-map.json`), submissions CIK кэш 6 ч, UA `portfolio-terminal/1.0 (personal research)`. Тесты на фикстурах.

### T4: остатки и флаги (чистая математика #2)
В `src/lab/detector.js`: `computeResiduals({prices, positions, factors})` — беты последнего окна (ридж, как в factors.js) → остаток r_t = ret_t − Σ β_f·ret_f,t по всей истории; `detectFlags(residuals, {k=2.5, cum=5}) → {t: {lastSigma, cumSigma, flag}}`. Тесты: синтетика — у «сломанной» бумаги (в конец ряда подмешан −25% скачок) lastSigma > 2.5; у чистой < порога.

### T5: `runDetector` — атрибуция + recs + роут
Остатки из факторного кэша (`factors.json` не хранит ряды → пересчитать alignPrices по позициям/прокси заново, кэш 24 ч как у факторов); по флагам (cooldown через `data/cache/attribution/{t}.json.checkedAt`, 7 дн): контекст = позиция-META + остатки в σ + заголовки + филлинги → `llm.chat` схема `{verdict: enum[beta_move|idiosyncratic_temporary|thesis_damage], reason, pillar, confidence}` → сохранить + append `data/recs.jsonl`. Роут `GET /api/lab/detector[?force=1]`; планировщик — ежедневно после уровней. Тест: мок llm+сеть — флаг → вердикт сохранён, recs пополнился, повтор без force не зовёт LLM.

### T6: `src/lab/falsify.js` — реестр фальсификаций
Реестр `data/falsifications.json`: `[{t, thesis, conditions:[{text}], createdAt, status:'active'|'triggered'|'retired', checks:[{date, verdicts:[{i, triggered, evidence}]}]}]`. `generate(t)` — тезис из META (note+tag+уровни) → LLM → ровно 3 измеримых условия; `check(t)` — новости+филлинги → поусловный вердикт; триггер → статус triggered + таймер в UI. Роуты `GET/POST /api/lab/falsify` (generate/check). Тесты на моках.

### T7: `src/lab/committee.js` — прогнозы + Brier
Грамматика: `{kind:'price_above'|'price_below', t, ref, x, horizon_days}` | `{kind:'index_above'|'index_below', ref, x, horizon_days}` | `{kind:'vix_above'|'vix_below', level, horizon_days}`. `runCommittee()`: контекст (портфель, топ-факторы, флаги детектора, отчёты ≤30 дн) × роли [bull, bear, devil, baserates] → 5 прогнозов каждая → append `data/predictions.jsonl` `{ts, role, event, prob, horizon_days, rationale}`. `scoreMatured()`: созревшие (now ≥ created+horizon) разрешаются ценами (chart/pool) → `outcome` дописывается; `brierByRole()` — средний (p−o)²; калибровка бакетами 20%; `consensusWeights()` = softmax(−brier) по ролям с ≥5 оценённых. Роуты `GET /api/lab/committee`, `POST run|score`. Тесты: разрешение исходов по синтетике, Brier-арифметика, softmax.

### T8: UI `/lab` — три секции + кнопки
«Детектор слома тезиса»: карточки вердиктов (тикер, ход в σ, verdict-плашка с цветом, причина, опора, confidence, источники-ссылки). «Реестр фальсификаций»: таблица (тикер, условия, статус, последний чек) + кнопки «Сгенерировать для…» (input) и «Проверить». «Комитет»: Brier по ролям + веса консенсуса + калибровка + последние прогнозы; кнопки «Созвать комитет» / «Оценить созревшие». POST-helper в server.js (JSON body). Стили в тон существующим.

### T9: Финальная верификация
`npm test` все PASS; smoke сервера; ЖИВОЙ прогон: `falsify generate` для одного тикера, `detector force=1`, `committee run` + `score` — по одному разу (бюджет); `git status` чист.

## Self-Review
1. Спек §6: клиент+лог (T1), RSS+EDGAR (T2/T3), остатки 2.5σ (T4), cooldown 7д+карточки+recs (T5), генерация 3 условий+ежеквартальный чек (T6), 4 роли×5 прогнозов+Brier+softmax-консенсус (T7), UI+каденции (T5/T6/T7/T8). Пропусков нет.
2. TBD нет; сигнатуры согласованы (chat/fetchImpl, chart/pool, readCache/writeCache).
3. Грамматика событий едина в T7 (score/run/UI).
