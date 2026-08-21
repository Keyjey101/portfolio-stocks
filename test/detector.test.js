'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { computeResiduals, detectFlags } = require('../src/lab/detector');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
function gauss(rnd) {
  const u = Math.max(Math.abs(rnd()), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const toPx = rs => { const p = [100]; rs.forEach((r, i) => p.push(p[i] * Math.exp(r))); return p; };

// чистая бумага: β=1 к фактору + маленький шум; сломанная: в конце −25% идио-скачок
function synth() {
  const rnd = lcg(31), T = 260;
  const F = Array.from({ length: T }, () => rnd() * 0.015);
  const clean = F.map(v => 1.0 * v + rnd() * 0.003);
  const broken = F.map(v => 1.0 * v + rnd() * 0.003);
  const drop = Array.from({ length: 5 }, (_, i) => -0.055 - i * 0.004); // суммарно ≈ −25%
  drop.forEach((d, i) => { broken[T - 5 + i] += d; });
  return {
    prices: { F1: toPx(F), SPY: toPx(F), CLEAN: toPx(clean), BROKEN: toPx(broken) },
    positions: [
      { t: 'CLEAN', tag: 'core', val: 500 },
      { t: 'BROKEN', tag: 'quality', val: 500 },
    ],
  };
}

test('computeResiduals: остатки = факт − факторная часть; беты в raw-единицах', () => {
  const { prices, positions } = synth();
  const res = computeResiduals({ prices, positions, factors: ['F1'], market: 'SPY' });
  assert.ok(res.residuals.CLEAN.every(r => Math.abs(r) < 0.05), 'остатки чистой бумаги маленькие');
  // флаг ловит только сломанную
  const flags = detectFlags(res.residuals, { k: 2.5, cum: 5 });
  assert.ok(flags.BROKEN.flag, 'сломанная поймана');
  assert.ok(!flags.CLEAN.flag, 'чистая не поймана');
  assert.ok(Math.abs(flags.BROKEN.lastSigma) > 2.5, 'в σ: ' + flags.BROKEN.lastSigma);
  assert.ok(Math.abs(flags.BROKEN.cumSigma) > 2.5, '5-дн накопленный тоже большой');
});

test('detectFlags: пустые/короткие ряды — без флага, без throw', () => {
  assert.deepEqual(detectFlags({}), {});
  assert.deepEqual(detectFlags({ X: [0.01] }), { X: { lastSigma: null, cumSigma: null, flag: false } });
});

test('computeResiduals: обычный шум не флагуется (σ честная)', () => {
  const rnd = lcg(77), T = 260;
  const F = Array.from({ length: T }, () => rnd() * 0.012);
  const noise = F.map(v => 0.6 * v + gauss(rnd) * 0.008);
  const prices = { F1: toPx(F), SPY: toPx(F), N1: toPx(noise) };
  const res = computeResiduals({ prices, positions: [{ t: 'N1', tag: 'core', val: 1 }], factors: ['F1'], market: 'SPY' });
  const flags = detectFlags(res.residuals, { k: 2.5, cum: 5 });
  assert.ok(!flags.N1.flag, 'обычная бумага без аномалий');
});
