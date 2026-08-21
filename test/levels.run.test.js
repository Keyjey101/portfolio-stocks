'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runLevels } = require('../src/lab/levels');

const DIR = path.join(__dirname, '..', 'data', 'cache');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const seedOf = sym => [...sym].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;

function chartJsonFor(sym, n = 520) {
  const rnd = lcg(seedOf(sym));
  const closes = [], ts = [];
  let p = 100;
  const t0 = Date.UTC(2024, 7, 1) / 1000;
  for (let i = 0; i < n; i++) {
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

test('runLevels: только позиции с уровнями; 2y заливка; повтор из кэша', async (t) => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const seen = new Set();
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async url => {
    calls++;
    const m = String(url).match(/\/chart\/([^?]+)/);
    const sym = decodeURIComponent(m[1]);
    seen.add(sym);
    if (String(url).includes('range=2y')) seen.add('range-2y:' + sym);
    return { ok: true, json: async () => chartJsonFor(sym) };
  };
  const positionsLoader = async () => [
    { t: 'TSM', qty: 3, lv: [380, 355, 340], until: null },
    { t: 'AYTU', qty: 14, lv: null },        // без уровней — не участвует
    { t: 'ITOT', qty: 0, lv: [999, 999, 999] }, // плановый DCA — не участвует
  ];
  const res = await runLevels({ force: true, positionsLoader, cacheName: 'test-levels' });
  assert.strictEqual(res.cached, false);
  assert.ok(Array.isArray(res.items) && res.items.length === 1, 'только TSM');
  const it = res.items[0];
  assert.strictEqual(it.t, 'TSM');
  assert.strictEqual(it.levels.length, 3);
  assert.ok(it.levels.every(l => l.p >= 0 && l.p <= 1));
  assert.ok(it.sigAnn > 0);
  const callsAfter = calls;
  const res2 = await runLevels({ positionsLoader, cacheName: 'test-levels' });
  assert.strictEqual(res2.cached, true);
  assert.strictEqual(calls, callsAfter, 'повтор не ходит в сеть');
  assert.ok(seen.has('range-2y:TSM'), 'заливка именно 2y');
});

after(() => {
  try { fs.unlinkSync(path.join(DIR, 'test-levels.json')); } catch {}
});
