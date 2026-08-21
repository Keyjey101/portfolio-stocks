'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'data');
const DEC = path.join(DIR, 'decisions.jsonl');
const PEND = path.join(DIR, 'trades-pending.json');
const REC = path.join(DIR, 'recs.jsonl');
for (const f of [DEC, PEND, REC]) if (fs.existsSync(f)) fs.copyFileSync(f, f + '.c4bak');
fs.writeFileSync(DEC, '');
fs.writeFileSync(REC, '');

const J = require('../src/lab/journal');

after(() => {
  for (const f of [DEC, PEND, REC]) {
    if (fs.existsSync(f + '.c4bak')) { fs.copyFileSync(f + '.c4bak', f); fs.unlinkSync(f + '.c4bak'); }
    else if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('addDecision/listDecisions: валидация и append', () => {
  const d = J.addDecision({ type: 'buy', t: 'TSM', qty: 3, price: 400, rationale: 'уровень T1', tags: ['уровень'] });
  assert.ok(d.ts && d.id);
  assert.throws(() => J.addDecision({ type: 'wat', t: 'TSM' }), /type/);
  assert.throws(() => J.addDecision({ type: 'buy', t: 'TSM', qty: 0 }), /qty/);
  assert.strictEqual(J.listDecisions().length, 1);
});

test('detectTrades: дифф снапшотов позиций', () => {
  const prev = [{ t: 'TSM', qty: 3 }, { t: 'PSN', qty: 15 }, { t: 'AYTU', qty: 14 }];
  const next = [{ t: 'TSM', qty: 8 }, { t: 'PSN', qty: 15 }]; // докупка + полный выход
  const diffs = J.detectTrades(prev, next);
  assert.deepEqual(diffs.find(d => d.t === 'TSM'), { t: 'TSM', prevQty: 3, qty: 8, dQty: 5 });
  assert.deepEqual(diffs.find(d => d.t === 'AYTU'), { t: 'AYTU', prevQty: 14, qty: 0, dQty: -14 });
  assert.strictEqual(diffs.find(d => d.t === 'PSN'), undefined, 'без изменений не попадает');
});

test('pendingTrades: сохранение и резолв', () => {
  const p = J.pendingTrades([{ t: 'TSM', prevQty: 3, qty: 8, dQty: 5 }]);
  assert.ok(p.id && p.ts && p.diffs.length === 1);
  // повторный вызов с теми же диффами не плодит записи
  const p2 = J.pendingTrades([{ t: 'TSM', prevQty: 3, qty: 8, dQty: 5 }]);
  assert.strictEqual(p2.id, p.id, 'идемпотентно');
  const ok = J.resolvePending(p.id, { type: 'buy', t: 'TSM', qty: 5, price: 400, rationale: 'докупка по уровню' });
  assert.ok(ok);
  assert.strictEqual(J.pendingTrades([]).diffs.length, 0, 'после резолва пусто');
});

test('computeCounterfactuals: sell vs hold, buy vs равновес вотчлиста', async () => {
  const now = Date.now();
  const d40 = new Date(now - 40 * 864e5).toISOString();
  fs.writeFileSync(DEC, [
    JSON.stringify({ id: 'a', ts: d40, type: 'sell', t: 'MRVL', qty: 1, price: 311, rationale: '' }),
    JSON.stringify({ id: 'b', ts: d40, type: 'buy', t: 'TSM', qty: 3, price: 400, rationale: '' }),
    JSON.stringify({ id: 'c', ts: new Date(now - 5 * 864e5).toISOString(), type: 'buy', t: 'NOW', qty: 1, price: 130, rationale: '' }), // молодое — не считается
  ].join('\n') + '\n');

  // цены: с даты решения (40 дней назад ≈ 28 торговых дней) до сейчас
  const priceLoader = async (t, daysAgo) => {
    const px = { MRVL: [311, 290], TSM: [400, 430], NOW: [130, 125], INCY: [120, 126], ISRG: [430, 440], AMAT: [200, 205], MKSI: [260, 262] };
    return px[t] ? px[t][daysAgo >= 28 ? 0 : 1] : null;
  };
  const out = await J.computeCounterfactuals({ decisions: J.listDecisions(), priceLoader, watch: ['INCY', 'ISRG', 'AMAT', 'MKSI'] });
  assert.strictEqual(out.length, 2, 'только старше 30 дней');

  const sell = out.find(x => x.id === 'a');
  // факт: продал по 311; альтернатива держать: 290 → удержание дало бы −6.8%
  assert.ok(Math.abs(sell.actualPct - 0) < 1e-9, 'продано по цене решения');
  assert.ok(sell.alternativePct < 0 && Math.abs(sell.alternativePct + 6.75) < 0.1, 'hold: ' + sell.alternativePct);
  assert.ok(sell.edgePct > 0, 'продажа оказалась лучше');

  const buy = out.find(x => x.id === 'b');
  // равновес вотчлиста: (126/120−1 + 440/430−1 + 205/200−1 + 262/260−1)/4
  const eq = ((126 / 120 - 1) + (440 / 430 - 1) + (205 / 200 - 1) + (262 / 260 - 1)) / 4;
  assert.ok(Math.abs(buy.alternativePct - eq * 100) < 0.01);
  assert.ok(Math.abs(buy.actualPct - 7.5) < 0.01, 'TSM 400→430');
});

test('adviceAccuracy: detector thesis_damage — упала ли цена за 30 дней после рекомендации', async () => {
  const now = Date.now();
  fs.writeFileSync(REC, [
    JSON.stringify({ ts: new Date(now - 40 * 864e5).toISOString(), kind: 'detector', t: 'PSN', verdict: 'thesis_damage', reason: '' }),
    JSON.stringify({ ts: new Date(now - 40 * 864e5).toISOString(), kind: 'detector', t: 'ZTS', verdict: 'thesis_damage', reason: '' }),
    JSON.stringify({ ts: new Date(now - 3 * 864e5).toISOString(), kind: 'detector', t: 'NVO', verdict: 'thesis_damage', reason: '' }), // не созрело
  ].join('\n') + '\n');
  const loader = async (t, daysAgo) => {
    const px = { PSN: [50, 42], ZTS: [80, 90], NVO: [44, 44] };
    return px[t] ? px[t][daysAgo >= 28 ? 0 : 1] : null;
  };
  const acc = await J.adviceAccuracy({ recs: null, priceLoader: loader });
  assert.strictEqual(acc.n, 2);
  assert.strictEqual(acc.hits, 1, 'PSN упал — совет верный; ZTS вырос — промах');
  assert.ok(Math.abs(acc.meanRet - ((42 / 50 - 1) + (90 / 80 - 1)) / 2 * 100) < 0.01);
});
