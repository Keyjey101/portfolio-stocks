'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runMC } = require('../src/lab/mc');

const DIR = path.join(__dirname, '..', 'data', 'cache');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const seedOf = sym => [...sym].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;

function chartJsonFor(sym, n = 520) {
  const rnd = lcg(seedOf(sym));
  // скрытая двухрежимность: каждые ~60 дней смена режима волатильности
  const closes = [], ts = [];
  let p = 100;
  const t0 = Date.UTC(2024, 7, 1) / 1000;
  let vol = 0.01;
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) vol = vol === 0.01 ? 0.03 : 0.01;
    p *= Math.exp(rnd() * 2 * vol);
    closes.push(+p.toFixed(4));
    ts.push(t0 + i * 86400);
  }
  return { chart: { result: [{
    meta: { regularMarketPrice: closes.at(-1) },
    timestamp: ts,
    indicators: { quote: [{ close: closes }] },
  }] } };
}

test('runMC (inline): синтетика 2y → режимы, терминальные перцентили, кэш', async (t) => {
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
  ];
  const res = await runMC({ force: true, inline: true, paths: 300, positionsLoader, cacheName: 'test-mc' });
  assert.strictEqual(res.cached, false);
  assert.ok(res.k >= 2 && res.k <= 3, 'k=' + res.k);
  assert.ok(res.params.monthlyUsd > 0 && res.params.years >= 1);
  assert.ok(res.base.terminal.p50 > 0);
  assert.ok(res.base.yearly.length === res.params.years);
  assert.ok(res.sens.double.p50 >= res.sens.base.p50, 'больше довнесений — выше медиана');
  assert.ok(Array.isArray(res.stateStats) && res.stateStats.length === res.k);
  const callsAfter = calls;
  const res2 = await runMC({ inline: true, positionsLoader, cacheName: 'test-mc' });
  assert.strictEqual(res2.cached, true);
  assert.strictEqual(calls, callsAfter, 'повтор не ходит в сеть');
});

after(() => {
  try { fs.unlinkSync(path.join(DIR, 'test-mc.json')); } catch {}
});
