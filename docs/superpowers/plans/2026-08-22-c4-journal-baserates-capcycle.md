# Часть C4 — журнал решений (#6), базовые ставки (#7), капцикл (#8): план

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans to implement this plan task-by-task.

**Goal:** журнал решений с автодетектом сделок и контрфактуалами; эмпирическая база событий S&P 500 с запросом через LLM; композит капитального цикла с капексом гиперскейлеров из XBRL.

**Architecture:** `src/lab/journal.js` (decisions.jsonl, снапшот-дифф Tradernet, контрфактуалы по ценам Yahoo, точность советов из recs.jsonl), `src/lab/baserates.js` (вселенная Wikipedia → 10y заливка → события → агрегаты), `src/lab/capcycle.js` (месячный композит из бесплатных рядов + капекс через EDGAR companyconcept XBRL — без LLM-извлечения, ноль галлюцинаций; ручной слот цен аренды GPU). UI: модалка в главном дашборде + три секции в /lab.

**Spec:** `docs/superpowers/specs/2026-08-21-part-c-lab-design.md`, раздел 7.

## Global Constraints
- Node ≥ 18.14, без npm-зависимостей; только бесплатные источники.
- Эмпирика #7 помечена survivorship bias в UI; LLM-приор помечен «мнение модели».
- Капекс — только XBRL-факты (us-gaap:PaymentsToAcquirePropertyPlantAndEquipment), не LLM.
- Все логи append-only JSONL с `ts`.

## Tasks
- **T1 journal.js**: `addDecision`, `listDecisions`, `detectTrades(prev, next) → diffs`, `pendingTrades(state)`, `computeCounterfactuals({decisions, priceLoader})` (старше 30 дней: sell→hold, buy/skip→вотчлист-равновес), `adviceAccuracy(recs, priceLoader)` (detector thesis_damage: −? за 30 дн). Тесты на синтетике.
- **T2 routes+UI journal**: POST/GET `/api/journal`, GET `/api/journal/pending`, POST `/api/journal/pending/resolve`; планировщик: снапшот-дифф каждые 15 мин, контрфактуалы еженедельно; модалка в index.html/app.js + секция в /lab.
- **T3 baserates.js**: `parseSp500(html)`, `extractEvents(closes, ts) → {drawdown40:[], shock15:[]}` (просадка ≥40% от 52-нед максимума, шок ≤−15%/день; форвард 21/63/126/252 дн, доля восстановившихся), `aggregate(events)`, `backfill({limit})` с кэшем вселенной (89 дн) и одноразовой заливкой, `query(text)` → LLM-класс → эмпирика+приор. Тесты на синтетике + фикстуре Wikipedia.
- **T4 routes+UI baserates**: GET `/api/lab/baserates` (агрегаты + баннер), POST query. Секция в /lab.
- **T5 capcycle.js**: `zscore`, `buildComposite(prices)` (RS60 SOX/URA/SEMI/SPY + TLT, среднее z), `stageOf(composite)` (0–3), `fetchCapex({fetchImpl})` (CIK гиперскейлеров → companyconcept JSON → TTM y/y), `runCapcycle({force})` → кэш 7 дн + история ежемесячно; ручной слот GPU (`addGpuRent(usd)`). Тесты на синтетике.
- **T6 routes+UI capcycle**: GET/POST `/api/lab/capcycle`; секция в /lab (стадия, компоненты, капекс TTM, GPU-слот, kill-switch маркировка); планировщик: композит ежемесячно, капекс ежеквартально.
- **T7 финал**: `npm test`, smoke сервера, живые прогоны (backfill baserates подмножеством, capcycle force, один journal-решение), `git status` чист.

## Self-Review
1. Спек §7: автодетект+форма (T1/T2), контрфактуалы hold/равновес/DCA-заменители и точность советов (T1/T2), S&P500+10y+события+LLM-приор с метками (T3/T4), композит+капекс+ручной слот+kill-switch (T5/T6). Пропусков нет.
2. TBD нет; сигнатуры согласованы (priceLoader/chart/pool/readCache/writeCache/chat DI).
