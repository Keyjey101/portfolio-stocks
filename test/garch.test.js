'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fitGARCH, garchForecast } = require('../src/math/timeseries');
const { lcg } = require('../src/math/stats');

function gaussMaker(rnd) {
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    const u = Math.max(rnd(), 1e-12), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// симуляция GARCH(1,1): ω=1.5e-6, α=0.08, β=0.90 (σ_день ≈ 0.87%)
function simulateGARCH(n, seed) {
  const g = gaussMaker(lcg(seed));
  const omega = 1.5e-6, alpha = 0.08, beta = 0.90;
  let sig2 = omega / (1 - alpha - beta);
  const rets = [];
  for (let t = 0; t < n; t++) {
    const r = g() * Math.sqrt(sig2);
    rets.push(r);
    sig2 = omega + alpha * r * r + beta * sig2;
  }
  return rets;
}

test('fitGARCH: восстанавливает α и β симулированной GARCH', () => {
  const rets = simulateGARCH(4000, 42);
  const fit = fitGARCH(rets);
  assert.ok(Math.abs(fit.alpha - 0.08) < 0.05, 'alpha=' + fit.alpha);
  assert.ok(Math.abs(fit.beta - 0.90) < 0.05, 'beta=' + fit.beta);
  assert.ok(fit.omega > 5e-7 && fit.omega < 7.5e-6, 'omega=' + fit.omega);
  assert.ok(fit.sig2next > 0);
});

test('garchForecast: дальний горизонт сходится к безусловной дисперсии', () => {
  const rets = simulateGARCH(3000, 7);
  const fit = fitGARCH(rets);
  const fc = garchForecast(fit, 1260); // 5 лет
  const uncond = fit.omega / (1 - fit.alpha - fit.beta);
  assert.ok(Math.abs(fc.varAt - uncond) / uncond < 0.02,
    'varAt=' + fc.varAt + ' vs ' + uncond);
  assert.ok(fc.avgVar > 0 && fc.longRunVar > 0);
});

test('garchForecast: усреднение по 252 дням даёт разумную годовую сигму', () => {
  const rets = simulateGARCH(3000, 11);
  const fit = fitGARCH(rets);
  const fc = garchForecast(fit, 252);
  const sigAnn = Math.sqrt(252 * fc.avgVar);
  const uncond = Math.sqrt(252 * fit.omega / (1 - fit.alpha - fit.beta));
  assert.ok(Math.abs(sigAnn / uncond - 1) < 0.15,
    'sigAnn=' + sigAnn + ' vs uncond ' + uncond);
});
