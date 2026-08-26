'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP = path.join(__dirname, '..', 'data', 'cache', '.calendar-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.REPORTS_WATCH_FILE = path.join(TMP, 'watch.json');
process.env.THESES_FILE = path.join(TMP, 'theses.json');
process.env.KNOWN_EVENTS_FILE = path.join(TMP, 'known.json');

const cal = require('../src/lab/calendar');
const theses = require('../src/lab/theses');

const DAY = 864e5;
const now = new Date('2026-08-24T12:00:00Z');
const ts = d => now.getTime() + d * DAY;

test('syncWatch: складирует будущие отчёты, идемпотентен, подрезает старое', () => {
  const items = [{ t: 'TSM', ts: ts(10) }, { t: 'PSN', ts: ts(3) }, { t: 'TSM', ts: ts(10) }];
  const w = cal.syncWatch(items, now.getTime());
  assert.strictEqual(w.items.length, 2, 'дубликат t+ts не плодится');
  const w2 = cal.syncWatch([{ t: 'NOW', ts: ts(40) }], now.getTime());
  assert.strictEqual(w2.items.length, 3);
});

test('freezeMark: T−7 — заморозка; прошедшие и далёкие — нет', () => {
  const watch = [
    { t: 'PSN', ts: ts(3), processedAt: null },
    { t: 'TSM', ts: ts(10), processedAt: null },
    { t: 'GONE', ts: ts(-1), processedAt: null },
    { t: 'DONE', ts: ts(2), processedAt: new Date().toISOString() },
  ];
  const m = cal.freezeMark(watch, now.getTime());
  assert.ok(m.PSN && m.PSN.days === 3, 'отчёт через 3 дня — заморожено');
  assert.strictEqual(m.TSM, undefined, '10 дней — рано');
  assert.strictEqual(m.GONE, undefined, 'прошедший — не замораживаем');
  assert.strictEqual(m.DONE, undefined, 'обработанный — не замораживаем');
});

test('dueForChain: наступившие 12ч–10д назад и необработанные', () => {
  const watch = [
    { t: 'A', ts: ts(-0.2), processedAt: null },  // ~5ч назад — рано
    { t: 'B', ts: ts(-1), processedAt: null },     // вчера — пора
    { t: 'C', ts: ts(-15), processedAt: null },    // слишком старый (календарь потерян)
    { t: 'D', ts: ts(-2), processedAt: 'x' },      // уже обработан
  ];
  const due = cal.dueForChain({ watchItems: watch, now: now.getTime() });
  assert.deepStrictEqual(due.map(d => d.t), ['B']);
});

test('runEarningsChain: отчёт чистый в damaged (второй подряд) → recovering, якоря без второго LLM-вызова', async () => {
  theses.saveRecord({
    t: 'CHN', state: 'damaged', thesis: 'тест', pillars: [], damaged_pillars: ['опора'],
    history: [], levels: null, levels_history: [], recovery_conditions: ['условие 1'],
    clean_reports: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  let llmCalls = 0;
  const llm = { chat: async () => {
    llmCalls++;
    return {
      deterioration: false, recovery_confirmed: [0], damaged_pillars: [],
      proposed_state: 'recovering', evidence: 'гайденс подтверждён',
      eps: 6.9, eps_basis: 'гайденс', multiple_low: 12, multiple_high: 15, multiple_basis: 'сжат',
      haircut_pct: 0, confirm_event: 'Q4 отчёт', confirm_check: 'маржа',
    };
  } };
  let deriveCalls = 0;
  const derivator = async (T, opts = {}) => {
    deriveCalls++;
    assert.ok(opts.anchors && opts.anchors.eps === 6.9, 'якоря пришли из сверки, без LLM');
    return { levels: { t1: 72, t2: 65, t3: 58 } };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<rss></rss>', json: async () => ({}) });
  try {
    const res = await cal.runEarningsChain('CHN', { llm, watchItem: { t: 'CHN', ts: ts(-1) }, derivator, now });
    assert.strictEqual(res.state, 'recovering', 'второй чистый отчёт подряд');
    assert.strictEqual(llmCalls, 1, 'один LLM-вызов на цепочку');
    assert.strictEqual(deriveCalls, 1, 'перевывод с якорями из сверки');
    assert.ok(res.processedAt);
    const rec = theses.get('CHN');
    assert.strictEqual(rec.earnings.processedAt, res.processedAt, 'отметка «обработан» в записи');
    assert.ok(rec.review?.due, 'следующий дедлайн пересмотра назначен');
  } finally { globalThis.fetch = realFetch; }
});

test('runDueChains: дозревший отчёт обрабатывается один раз; без записи тезиса — помечается и не ретраится', async () => {
  const w = cal.readWatch();
  w.items.push({ t: 'NOTH', ts: ts(-1), processedAt: null });
  require('fs').writeFileSync(process.env.REPORTS_WATCH_FILE, JSON.stringify(w));
  let calls = 0;
  const llm = { chat: async () => { calls++; return {}; } };
  const out = await cal.runDueChains({ llm, calendarLoader: async () => ({ items: [] }), now });
  assert.ok(out.results.some(r => r.t === 'NOTH' && r.error), 'без записи тезиса — понятная ошибка');
  assert.strictEqual(calls, 0, 'LLM не тратится на тикер без тезиса');
  const w2 = cal.readWatch();
  assert.ok(w2.items.find(x => x.t === 'NOTH')?.processedAt, 'помечен обработанным — ретраев нет');
});
