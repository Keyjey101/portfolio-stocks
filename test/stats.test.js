'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { quantile, ranks, pearson, spearman, entropy } = require('../src/math/stats');

test('quantile: интерполяция по определению', () => {
  assert.strictEqual(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.strictEqual(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(quantile([10, 20], 0.25), 12.5);
  assert.strictEqual(quantile([], 0.5), null);
});

test('ranks: средние ранги при связях', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.deepEqual(ranks([3, 1, 2]), [3, 1, 2]);
});

test('pearson: идеальная линейная связь ±1', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3], [6, 4, 2]) + 1) < 1e-12);
});

test('spearman: монотонная нелинейная = 1; связки — средние ранги', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 10, 100, 1000]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [3, 2, 2, 1]) + 1) < 1e-12);
});

test('entropy: равномерное распределение из двух = ln2, вырожденное = 0', () => {
  assert.ok(Math.abs(entropy([0.5, 0.5]) - Math.log(2)) < 1e-12);
  assert.strictEqual(entropy([1]), 0);
  assert.ok(entropy([0.7, 0.3]) > 0);
});
