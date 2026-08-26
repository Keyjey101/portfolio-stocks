'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeFactorModel, orthogonalize } = require('../src/lab/factors');
const { pearson } = require('../src/math/stats');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const toPx = rs => { const p = [100]; rs.forEach((r, i) => p.push(p[i] * Math.exp(r))); return p; };

function synth() {
  const rnd = lcg(7), T = 300;
  const F1 = Array.from({ length: T }, () => rnd() * 0.02);
  const F2 = Array.from({ length: T }, () => rnd() * 0.02);
  const F3 = Array.from({ length: T }, () => rnd() * 0.02);
  const rA = F1.map((v, i) => 1.2 * v + 0.3 * F2[i] + rnd() * 0.002);
  const rB = F1.map((v, i) => -0.5 * v + 0.8 * F3[i] + rnd() * 0.002);
  const rC = F2.map(v => 0.9 * v + rnd() * 0.001);
  return {
    prices: { F1: toPx(F1), F2: toPx(F2), F3: toPx(F3), SPY: toPx(F1), A: toPx(rA), B: toPx(rB), C: toPx(rC) },
    positions: [
      { t: 'A', tag: 'core', val: 500 },
      { t: 'B', tag: 'real', val: 300 },
      { t: 'C', tag: 'quality', val: 200 },
    ],
  };
}

test('беты синтетики восстанавливаются (окно 60, шаг 5)', () => {
  const { prices, positions } = synth();
  const res = analyzeFactorModel({ prices, positions, factors: ['F1', 'F2', 'F3'], market: 'SPY' });
  assert.ok(Math.abs(res.betas.A.beta.F1 - 1.2) < 0.15, 'A.F1=' + res.betas.A.beta.F1);
  assert.ok(Math.abs(res.betas.A.beta.F2 - 0.3) < 0.15, 'A.F2=' + res.betas.A.beta.F2);
  assert.ok(Math.abs(res.betas.B.beta.F1 + 0.5) < 0.15, 'B.F1=' + res.betas.B.beta.F1);
  assert.ok(Math.abs(res.betas.C.beta.F2 - 0.9) < 0.15, 'C.F2=' + res.betas.C.beta.F2);
  // σβ положительны (окна дают разброс)
  assert.ok(res.betas.A.sigma.F1 > 0);
});

test('экспозиция портфеля = Σwᵢβᵢ, разбивка по тегам сходится', () => {
  const { prices, positions } = synth();
  const res = analyzeFactorModel({ prices, positions, factors: ['F1', 'F2', 'F3'], market: 'SPY' });
  const [wA, wB, wC] = [0.5, 0.3, 0.2];
  assert.ok(Math.abs(res.exposure.F1 - (wA * res.betas.A.beta.F1 + wB * res.betas.B.beta.F1 + wC * res.betas.C.beta.F1)) < 1e-9);
  assert.ok(Math.abs(res.byTag.core.F1 - wA * res.betas.A.beta.F1) < 1e-9);
  assert.ok(Math.abs(res.byTag.real.F1 - wB * res.betas.B.beta.F1) < 1e-9);
});

test('ENB: идентичные ряды ≈ 1, независимые ≈ 2', () => {
  const rnd = lcg(99), T = 250;
  const r1 = Array.from({ length: T }, () => rnd() * 0.02);
  const r2 = Array.from({ length: T }, () => rnd() * 0.02);
  const positions = [{ t: 'X1', tag: 'core', val: 1 }, { t: 'X2', tag: 'core', val: 1 }];
  const same = analyzeFactorModel({
    prices: { F1: toPx(r1), SPY: toPx(r1), X1: toPx(r1), X2: toPx(r1) },
    positions, factors: ['F1'], market: 'SPY',
  });
  assert.ok(same.enb < 1.15, 'ENB идентичных=' + same.enb);
  const indep = analyzeFactorModel({
    prices: { F1: toPx(r1), SPY: toPx(r1), X1: toPx(r1), X2: toPx(r2) },
    positions, factors: ['F1'], market: 'SPY',
  });
  assert.ok(indep.enb > 1.85, 'ENB независимых=' + indep.enb);
});

test('стресс-дней < 10 — режим не считается, corrJump пуст (не вводит в заблуждение)', () => {
  const rnd = lcg(11), T = 120;
  const mkt = Array.from({ length: T }, () => 0.002 + rnd() * 0.008); // ни одного дня < −2%
  const x = mkt.map(v => v + rnd() * 0.002);
  const prices = { F1: toPx(mkt), SPY: toPx(mkt), X: toPx(x) };
  const res = analyzeFactorModel({
    prices, positions: [{ t: 'X', tag: 'core', val: 100 }], factors: ['F1'], market: 'SPY',
  });
  assert.strictEqual(res.stress.n, 0);
  assert.strictEqual(res.stress.dr, null, 'стресс-DR не считается');
  assert.deepEqual(res.corrJump, [], 'corrJump пуст, а не «0 − ρнорм»');
});

test('стресс: дни рынка < −2% попадают в стресс-режим; корреляции осмысленные', () => {
  const rnd = lcg(5), T = 200;
  // стресс-дни варьируются вокруг −3%, обычные — вокруг +0,4%
  const mkt = Array.from({ length: T }, (_, i) =>
    (i % 5 === 0 ? -0.03 - rnd() * 0.01 : 0.004 + rnd() * 0.004));
  const x = mkt.map(v => 1.1 * v + rnd() * 0.0005);
  const y = Array.from({ length: T }, () => rnd() * 0.001);
  const prices = { F1: toPx(Array.from({ length: T }, () => rnd() * 0.01)), SPY: toPx(mkt), X: toPx(x), Y: toPx(y) };
  const res = analyzeFactorModel({
    prices, positions: [{ t: 'X', tag: 'core', val: 600 }, { t: 'Y', tag: 'real', val: 400 }],
    factors: ['F1'], market: 'SPY',
  });
  assert.strictEqual(res.stress.n, 40, 'стресс-дней T/5');
  assert.ok(res.stress.corr.X > 0.9, 'X коррелирует с рынком в стрессе: ' + res.stress.corr.X);
  assert.ok(Math.abs(res.stress.corr.Y) < 0.5, 'Y независим');
  assert.ok(res.normal.dr > 0 && res.stress.dr > 0, 'DR положителен в обоих режимах');
  assert.ok(res.corrJump.length === 2);
});

test('orthogonalize: остатки факторов не коррелируют с базой (рынком)', () => {
  const rnd = lcg(3), T = 300;
  const mkt = Array.from({ length: T }, () => rnd() * 0.02);
  const semi = mkt.map(v => 0.8 * v + rnd() * 0.008); // SMH = 0.8·SPY + шум
  const R = { SPY: mkt, SMH: semi };
  const orth = orthogonalize(R, ['SPY', 'SMH']);
  const c = pearson(orth.SPY, orth.SMH);
  assert.ok(Math.abs(c) < 0.05, 'орт-остаток SMH не коррелирует с SPY: ' + c);
});

test('#М6: ортогонализация чинит мультиколлинеарность — β(орто) читается как «сверх рынка»', () => {
  const { prices, positions } = synth(); // SPY = F1 (тот же ряд!)
  const res = analyzeFactorModel({ prices, positions, factors: ['F1', 'F2', 'F3'], market: 'SPY' });
  // сырая β A к F1 = 1.2, но F1 и есть рынок → сверх рынка чувствительность ≈ 0
  assert.ok(Math.abs(res.betas.A.beta.F1 - 1.2) < 0.15, 'сырая бета на месте');
  assert.ok(Math.abs(res.orthBetas.A.F1) < 0.15, 'орт-бета к рынко-фактору ≈ 0: ' + res.orthBetas.A.F1);
  // порядок: рынок первым
  assert.strictEqual(res.orthOrder[0], 'SPY');
  // R² и CI на месте
  assert.ok(res.r2.A > 0.9, 'A почти полностью объяснён факторами: ' + res.r2.A);
  const ci = res.betas.A.ci.F1;
  assert.ok(ci[0] < res.betas.A.beta.F1 && ci[1] > res.betas.A.beta.F1, 'β внутри своего 95% CI');
  assert.ok(res.orthExposure.SPY !== undefined && res.orthByTag.core !== undefined);
});
