'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeForGuest } = require('../src/signals');

const D = {
  generatedAt: '2026-08-22T00:00:00Z', posSource: 'api',
  vixV: 20, spxPx: 5000, y10: 4, verdict: { t: 'ОКНО НЕТ', c: 'r', n: 0, fires: [] },
  sV: {}, sT: {}, sY: {},
  rows: [
    { t: 'TSM', qty: 10, avg: 500, px: 600, val: 6000, pnl: 20, day: 1, tag: 'core', ok: true },
    { t: 'NTR', qty: 5, avg: 60, px: 66, val: 330, pnl: 10, day: -1, tag: 'real', ok: true },
  ],
  watch: [{ t: 'INCY', px: 60, day: 1 }],
  total: 6330, byTag: { core: 6000, real: 330 }, cash: 1000,
  rules: {
    ai: { pct: 0.947, val: 6000, hiddenPct: 1, target: 0.35, excess: 3784, c: 'r' },
    cash: { pct: 0.136, target: 0.1, short: 500, c: 'o' },
    max: { t: 'TSM', target: 0.084, pct: 0.947, c: 'r' },
    broken: { pct: 0.05, val: 300, overdue: ['PSN'], c: 'o' },
  },
};

test('гость не видит суммы: qty/avg/val/total/cash вырезаются на сервере', () => {
  const G = sanitizeForGuest(D);
  assert.strictEqual(G.guest, true);
  assert.strictEqual(G.total, null);
  assert.strictEqual(G.cash, null);
  G.rows.forEach(r => {
    assert.strictEqual(r.qty, null, r.t + ' qty');
    assert.strictEqual(r.avg, null, r.t + ' avg');
    assert.strictEqual(r.val, null, r.t + ' val');
  });
  assert.strictEqual(G.rules.ai.val, null);
  assert.strictEqual(G.rules.ai.excess, null);
  assert.strictEqual(G.rules.cash.short, null);
  assert.strictEqual(G.rules.broken.val, null);
});

test('проценты и вердикты остаются, byTag превращается в доли', () => {
  const G = sanitizeForGuest(D);
  assert.strictEqual(G.rows[0].pnl, 20);          // P&L в процентах — публичный
  assert.strictEqual(G.rows[0].px, 600);          // рыночная цена публична
  assert.strictEqual(G.verdict.c, 'r');
  assert.ok(Math.abs(G.byTag.core - 6000 / 6330 * 100) < 1e-9);
  assert.ok(Math.abs(G.byTag.real - 330 / 6330 * 100) < 1e-9);
  assert.ok(Math.abs(G.cashPct - 1000 / 7330 * 100) < 1e-9);
  assert.strictEqual(G.rules.ai.pct, 0.947);      // доли/цели правил остаются
  assert.strictEqual(G.rules.max.t, 'TSM');
  assert.deepEqual(G.rules.broken.overdue, ['PSN']);
});

test('исходные данные владельца не мутируют', () => {
  sanitizeForGuest(D);
  assert.strictEqual(D.rows[0].qty, 10);
  assert.strictEqual(D.total, 6330);
  assert.strictEqual(D.cash, 1000);
  assert.strictEqual(D.rules.ai.excess, 3784);
});
