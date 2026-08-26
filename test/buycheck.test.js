'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP = path.join(__dirname, '..', 'data', 'cache', '.buycheck-test.json');
process.env.THESES_FILE = TMP;
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);

const RECS = path.join(__dirname, '..', 'data', 'recs.jsonl');
const hadRecs = fs.existsSync(RECS);
if (hadRecs) fs.copyFileSync(RECS, RECS + '.bcbak');
fs.writeFileSync(RECS, '');

const { runBuyCheck, constraintCheck } = require('../src/lab/buycheck');
const theses = require('../src/lab/theses');

test('constraintCheck: что пробьёт покупка на $usd', () => {
  const row = { t: 'TSM', tag: 'core', val: 3000, coreVal: 3000 };
  const c = constraintCheck({ row, total: 8500, cash: 500, usd: 2000, tag: 'core' });
  assert.ok(Math.abs(c.aiPct - 5000 / 10500) < 1e-9, 'AI-доля после покупки');
  assert.strictEqual(c.aiBreached, true, 'потолок 35% пробит');
  assert.ok(Math.abs(c.namePctAfter - 5000 / 10500) < 1e-9);
  assert.strictEqual(c.nameBreached, true, 'потолок имени 8,4% пробит');
  assert.strictEqual(c.cashBreached, true, 'кэша не хватает');
  // покупка некор-тега не раздувает AI-долю
  const c2 = constraintCheck({ row: { t: 'PSN', tag: 'quality', val: 100, coreVal: 3000 }, total: 8500, cash: 500, usd: 100, tag: 'quality' });
  assert.strictEqual(c2.aiBreached, false);
  assert.strictEqual(constraintCheck({ row: null, total: 0, cash: 0, usd: 100, tag: null }), null);
});

test('runBuyCheck: полный чек-лист, решение однозначное, размер считает машина', async () => {
  theses.saveRecord({
    t: 'BCHE', state: 'damaged', thesis: 'тест', pillars: [], damaged_pillars: ['x'],
    history: [{ date: '2026-07-01T00:00:00Z', from: 'intact', to: 'damaged', trigger: 'detector', evidence: 'e', source: 'detector' }],
    levels: { t1: 65, t2: 62, t3: 58, until: { event: 'Q4 отчёт', check: 'маржа' }, conditional: true, derived_at: '2026-08-01T00:00:00Z', px_at: 70, basis: 'b' },
    levels_history: [], recovery_conditions: [], clean_reports: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  const dataLoader = async () => ({
    total: 8500, cash: 500,
    rows: [
      { t: 'BCHE', tag: 'quality', val: 1000, px: 62, ok: true },
      { t: 'TSM', tag: 'core', val: 3000, px: 400, ok: true },
    ],
    watch: [],
  });
  const calendarLoader = async () => ({ items: [{ t: 'BCHE', ts: Date.now() + 3 * 864e5, days: 3 }] });
  const llm = { chat: async () => ({
    classification: 'damage', decision: 'wait', wait_what: 'стабилизации US-сегмента в отчёте',
    missing: [], reason: 'тезис повреждён, уровень условный',
  }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '<rss></rss>', json: async () => ({}) });
  try {
    const res = await runBuyCheck({ t: 'bche', usd: 500, llm, dataLoader, calendarLoader });
    assert.strictEqual(res.t, 'BCHE');
    assert.strictEqual(res.decision, 'wait');
    assert.strictEqual(res.checklist.thesis.state, 'damaged');
    assert.strictEqual(res.checklist.levels.inZone, true, 'цена 62 в зоне T1=65');
    assert.ok(res.checklist.levels.until.includes('Q4'));
    assert.ok(res.checklist.binaryRisk.days === 3, 'отчёт через 3 дня — бинарный риск');
    assert.strictEqual(res.size.shares, Math.floor(500 / 62));
    assert.ok(res.checklist.constraints);
    // совет записан в журнал рекомендаций для будущей точности
    const lines = fs.readFileSync(RECS, 'utf8').split('\n').filter(Boolean);
    assert.ok(JSON.parse(lines.at(-1)).kind === 'buycheck');
  } finally { globalThis.fetch = realFetch; }
});

test('runBuyCheck: валидация входа', async () => {
  await assert.rejects(() => runBuyCheck({ t: '123', usd: 100, llm: { chat: async () => ({}) } }), /тикер/);
  await assert.rejects(() => runBuyCheck({ t: 'TSM', usd: 0, llm: { chat: async () => ({}) } }), /сумма/);
});

after(() => {
  if (hadRecs) { fs.copyFileSync(RECS + '.bcbak', RECS); fs.unlinkSync(RECS + '.bcbak'); }
  else if (fs.existsSync(RECS)) fs.unlinkSync(RECS);
});
