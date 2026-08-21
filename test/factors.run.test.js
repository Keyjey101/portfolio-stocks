'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runFactors, alignPrices } = require('../src/lab/factors');

const DIR = path.join(__dirname, '..', 'data', 'cache');

test('alignPrices: индексы с разным временем суток внутри дня выравниваются по календарному дню', () => {
  // регрессия: ^GSPC приходит 13:30 UTC, ^VIX — 07:00, ^TNX — 13:00;
  // точное пересечение секунд пусто — выравниваем по floor(ts/86400)
  const raw = {
    A: { closes: [10, 11, 12], ts: [1724247000, 1724333400, 1724419800] }, // 13:30
    B: { closes: [20, 21, 22], ts: [1724223600, 1724310000, 1724396400] }, // 07:00
    C: { closes: [30, 31, 32], ts: [1724242800, 1724329200, 1724415600] }, // 13:00
  };
  const out = alignPrices(raw);
  assert.strictEqual(Object.keys(out).length, 3);
  for (const k of Object.keys(out)) {
    assert.strictEqual(out[k].length, 3, k + ' выровнен на 3 общих дня');
  }
  assert.deepEqual(out.A, [10, 11, 12]);
  assert.deepEqual(out.B, [20, 21, 22]);
  // день, отсутствующий у одного ряда, исключается у всех
  const raw2 = {
    A: { closes: [10, 11, 12], ts: [100, 200, 300].map(d => d * 86400) },
    B: { closes: [20, 21], ts: [100, 300].map(d => d * 86400) },
  };
  const out2 = alignPrices(raw2);
  assert.deepEqual(out2.A, [10, 12]);
  assert.deepEqual(out2.B, [20, 21]);
});


function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const seedOf = sym => [...sym].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;

function chartJsonFor(sym) {
  const rnd = lcg(seedOf(sym));
  const closes = [], ts = [];
  let p = 100;
  const t0 = Date.UTC(2025, 8, 1) / 1000;
  for (let i = 0; i < 260; i++) {
    p *= Math.exp(rnd() * 0.02);
    closes.push(+p.toFixed(4));
    ts.push(t0 + i * 86400);
  }
  return { chart: { result: [{
    meta: { regularMarketPrice: closes.at(-1) },
    timestamp: ts,
    indicators: { quote: [{ close: closes }] },
  }] } };
}

test('runFactors: синтетика → результат; повтор — из кэша без сети', async (t) => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async url => {
    calls++;
    const m = String(url).match(/\/chart\/([^?]+)/);
    return { ok: true, json: async () => chartJsonFor(decodeURIComponent(m[1])) };
  };
  const positionsLoader = async () => [
    { t: 'AAA', qty: 10, avg: 10, tag: 'core' },
    { t: 'BBB', qty: 5, avg: 20, tag: 'real' },
    { t: 'ITOT', qty: 0, avg: 0, tag: 'index' },
  ];
  const res = await runFactors({ force: true, positionsLoader, cacheName: 'test-factors' });
  assert.strictEqual(res.cached, false);
  assert.ok(typeof res.exposure.SMH === 'number');
  assert.ok(res.enb >= 1 && res.enb <= res.tickers.length);
  assert.ok(res.tickers.includes('ITOT'), 'ITOT участвует в ENB');
  const callsAfter = calls;
  const res2 = await runFactors({ positionsLoader, cacheName: 'test-factors' });
  assert.strictEqual(res2.cached, true);
  assert.strictEqual(calls, callsAfter, 'повтор не ходит в сеть');
});

after(() => {
  try { fs.unlinkSync(path.join(DIR, 'test-factors.json')); } catch {}
});
