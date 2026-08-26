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
process.env.THESES_FILE = path.join(DIR, 'cache', '.theses-journal-test.json');

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

test('computeCounterfactuals: горизонты 30/90/365, hold/вотчлист/ITOT', async () => {
  const now = Date.now();
  const d100 = new Date(now - 100 * 864e5).toISOString();
  fs.writeFileSync(DEC, [
    JSON.stringify({ id: 'a', ts: d100, type: 'sell', t: 'MRVL', qty: 1, price: 311, rationale: '' }),
    JSON.stringify({ id: 'b', ts: d100, type: 'buy', t: 'TSM', qty: 3, price: 400, rationale: '' }),
    JSON.stringify({ id: 'c', ts: new Date(now - 5 * 864e5).toISOString(), type: 'buy', t: 'NOW', qty: 1, price: 130, rationale: '' }), // молодое — не считается
  ].join('\n') + '\n');

  // 100 дней назад ≈ 71 торговый день; 30-д горизонт ≈ 21 торговый от тогда
  const priceLoader = async (t, daysAgo) => {
    const px = {
      // [на дату решения, на +30д горизонта, сейчас]
      MRVL: [311, 290, 280], TSM: [400, 430, 460], NOW: [130, 125, 128],
      ITOT: [100, 104, 110],
      INCY: [120, 126, 130], ISRG: [430, 440, 450], AMAT: [200, 205, 210], MKSI: [260, 262, 265],
    };
    const row = px[t];
    if (!row) return null;
    if (daysAgo >= 71) return row[0];
    if (daysAgo >= 45) return row[1];
    return row[2];
  };
  const out = await J.computeCounterfactuals({ decisions: J.listDecisions(), priceLoader, watch: ['INCY', 'ISRG', 'AMAT', 'MKSI'] });
  assert.strictEqual(out.length, 2, 'только старше 30 дней');
  // 100 дней созрели 30-й и 90-й горизонты, 365-й — нет
  for (const x of out) {
    assert.deepStrictEqual(x.horizons.map(h => h.h), [30, 90]);
  }

  const sell = out.find(x => x.id === 'a').horizons.find(h => h.h === 30);
  assert.ok(Math.abs(sell.actualPct - 0) < 1e-9, 'продано по цене решения');
  assert.ok(sell.holdPct < 0 && Math.abs(sell.holdPct + 6.75) < 0.1, 'держать было бы −6.8%: ' + sell.holdPct);

  const buy = out.find(x => x.id === 'b').horizons.find(h => h.h === 30);
  assert.ok(Math.abs(buy.actualPct - 7.5) < 0.01, 'TSM 400→430');
  const eq = ((126 / 120 - 1) + (440 / 430 - 1) + (205 / 200 - 1) + (262 / 260 - 1)) / 4;
  assert.ok(Math.abs(buy.watchPct - eq * 100) < 0.01, 'равновес вотчлиста');
  assert.ok(Math.abs(buy.itotPct - 4) < 0.01, 'ITOT 100→104');
  assert.ok(Math.abs(buy.edgePct - (7.5 - eq * 100)) < 0.02);
});

test('twr: под периоды между довнесениями, поток исключается из обеих границ', () => {
  // рынок растёт +10%/мес; 1 марта довнесли $21 (в NAV 142 = 121 рынок + 21 ввод)
  const nav = [
    { date: '2026-01-01', total: 100 },
    { date: '2026-02-01', total: 110 },
    { date: '2026-03-01', total: 142 },
    { date: '2026-04-01', total: 133.1 },
  ];
  const r = J.twr(nav, [{ date: '2026-03-01', usd: 21 }]);
  // сегмент1 (янв→март, до ввода): 121/100 = +21%; сегмент2: 133.1/121 = +10%
  assert.ok(Math.abs(r.value - (1.1 * 1.1 * 1.1 - 1)) < 1e-9, 'TWR: ' + r.value);
  assert.strictEqual(r.segments, 2);
  assert.strictEqual(J.twr([{ date: '2026-01-01', total: 100 }]), null, 'меньше двух точек — null');
  // без потоков — простое отношение краёв
  const plain = J.twr(nav.slice(0, 2), []);
  assert.ok(Math.abs(plain.value - 0.10) < 1e-9);
});

test('appendNav/listNav: один снапшот в день', () => {
  const navFile = path.join(DIR, 'cache', '.nav-test.jsonl');
  process.env.NAV_FILE = navFile;
  try {
    fs.writeFileSync(navFile, '');
    J.appendNav(100, new Date('2026-08-24T10:00:00Z'));
    J.appendNav(105, new Date('2026-08-24T18:00:00Z')); // тот же день — замещает
    J.appendNav(107, new Date('2026-08-25T18:00:00Z'));
    const nav = J.listNav();
    assert.strictEqual(nav.length, 2);
    assert.strictEqual(nav[0].total, 105, 'внутридневное — последнее');
    assert.strictEqual(nav[1].date, '2026-08-25');
  } finally { delete process.env.NAV_FILE; fs.rmSync(navFile, { force: true }); }
});

test('levelsAccuracy: коснувшиеся уровни и исход через 30 торговых дней', async () => {
  const now = Date.now();
  // спад 120→75, затем отскок до 110: касание T3=80 и рост через 30 точек
  const closes = [
    ...Array.from({ length: 60 }, (_, i) => 120 - 0.75 * i), // 120 → 75.25
    ...Array.from({ length: 35 }, (_, i) => 75 + i),          // 75 → 109
  ];
  const seriesLoader = async () => closes;
  const items = {
    TST: { levels_history: [{ ts: new Date(now - 120 * 864e5).toISOString(), t1: 100, t2: 90, t3: 80 }] },
    FRESH: { levels_history: [{ ts: new Date(now - 10 * 864e5).toISOString(), t1: 100, t2: 90, t3: 80 }] }, // молодая — мимо
  };
  const acc = await J.levelsAccuracy({ items, seriesLoader });
  assert.strictEqual(acc.n, 1);
  assert.strictEqual(acc.good, 1, 'после касания цена выросла');
  assert.ok(acc.meanRet > 0);
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
