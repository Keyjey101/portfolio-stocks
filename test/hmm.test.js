'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fitGaussianHMM, selectHMM } = require('../src/math/hmm');
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

// два режима: спокойный N(0,1) и сдвинутый N(4,1), переходы редки (3%/5%)
function twoRegimes(n, seed) {
  const rnd = lcg(seed), g = gaussMaker(rnd);
  let s = 0;
  const X = [], truth = [];
  for (let t = 0; t < n; t++) {
    if (rnd() < (s === 0 ? 0.03 : 0.05)) s = 1 - s;
    truth.push(s);
    X.push([s === 0 ? g() : 4 + g()]);
  }
  return { X, truth };
}

test('fitGaussianHMM: восстанавливает режимы двухрежимного синтеза', () => {
  const { X, truth } = twoRegimes(2000, 42);
  const fit = fitGaussianHMM(X, 2);
  // выравнивание по средним: состояние с меньшим mean ↔ режим 0
  const flip = fit.means[0][0] > fit.means[1][0];
  const pred = fit.states.map(s => (flip ? 1 - s : s));
  const acc = pred.filter((p, i) => p === truth[i]).length / truth.length;
  assert.ok(acc > 0.95, 'accuracy=' + acc);
  assert.ok(fit.A[0][0] > 0.9 && fit.A[1][1] > 0.9,
    'переходы редки: ' + JSON.stringify(fit.A));
  assert.ok(Math.abs(Math.min(...fit.means.map(m => m[0])) - 0) < 0.3);
  assert.ok(Math.abs(Math.max(...fit.means.map(m => m[0])) - 4) < 0.3);
});

test('selectHMM: BIC выбирает 2 состояния на двухрежимном синтезе', () => {
  const { X } = twoRegimes(1500, 7);
  const { best } = selectHMM(X, [2, 3]);
  assert.strictEqual(best.k, 2, 'k=' + best.k);
});

test('fitGaussianHMM: трёхпризнаковый ввод не падает, формы корректны', () => {
  const rnd = lcg(5), g = gaussMaker(rnd);
  const X = Array.from({ length: 500 }, () => [g(), g() * 2, g() + 1]);
  const fit = fitGaussianHMM(X, 2);
  assert.strictEqual(fit.means.length, 2);
  assert.strictEqual(fit.means[0].length, 3);
  assert.strictEqual(fit.vars.length, 2);
  assert.ok(Number.isFinite(fit.ll));
  assert.ok(fit.states.length === 500);
});
