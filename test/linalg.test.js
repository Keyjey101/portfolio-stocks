'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { solve, standardizeCols, ridgeSolve, jacobiEigen } = require('../src/math/linalg');

// детерминированный ГПСЧ для синтетики
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}

test('solve: СЛАУ 2×2', () => {
  const x = solve([[2, 1], [1, 3]], [5, 10]);
  assert.ok(Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[1] - 3) < 1e-9);
});

test('solve: вырожденная матрица → throw', () => {
  assert.throws(() => solve([[1, 2], [2, 4]], [1, 2]), /singular/);
});

test('standardizeCols: нулевое среднее, единичная дисперсия', () => {
  const { Z } = standardizeCols([[1, 10], [2, 20], [3, 30], [4, 40]]);
  assert.ok(Math.abs(Z.reduce((s, r) => s + r[0], 0)) < 1e-12);
  const ss = Z.reduce((s, r) => s + r[1] * r[1], 0) / 3;
  assert.ok(Math.abs(Math.sqrt(ss) - 1) < 1e-9);
});

test('ridgeSolve: восстанавливает беты синтетики', () => {
  const rnd = lcg(42), n = 250, k = 3;
  const X = Array.from({ length: n }, () => Array.from({ length: k }, () => rnd() * 0.02));
  const { Z } = standardizeCols(X);
  const betaTrue = [0.8, -0.5, 1.2];
  const y = Z.map(row => row.reduce((s, v, j) => s + v * betaTrue[j], 0) + rnd() * 0.005);
  const b = ridgeSolve(Z, y, 1e-4 * n);
  betaTrue.forEach((bt, j) => assert.ok(Math.abs(b[j] - bt) < 0.1, `beta${j}: ${b[j]} vs ${bt}`));
});

test('jacobiEigen: диагональ и матрицы с известным спектром', () => {
  assert.deepEqual(jacobiEigen([[2, 0], [0, 3]]), [3, 2]);
  const e2 = jacobiEigen([[2, 1], [1, 2]]);
  assert.ok(Math.abs(e2[0] - 3) < 1e-8 && Math.abs(e2[1] - 1) < 1e-8);
  const e3 = jacobiEigen([[2, 1, 0], [1, 2, 1], [0, 1, 2]]); // 2±√2 и 2
  [2 + Math.SQRT2, 2, 2 - Math.SQRT2].forEach((ev, i) =>
    assert.ok(Math.abs(e3[i] - ev) < 1e-7, `eig${i}: ${e3[i]} vs ${ev}`));
});
