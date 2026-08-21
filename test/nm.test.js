'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { nelderMead } = require('../src/math/timeseries');

test('nelderMead: Розенброк → [1,1]', () => {
  const f = ([x, y]) => 100 * (y - x * x) ** 2 + (1 - x) ** 2;
  const { x, fx } = nelderMead(f, [-1.2, 1], { maxIter: 400 });
  assert.ok(Math.abs(x[0] - 1) < 1e-2, 'x=' + x[0]);
  assert.ok(Math.abs(x[1] - 1) < 1e-2, 'y=' + x[1]);
  assert.ok(fx < 1e-4, 'fx=' + fx);
});

test('nelderMead: квадратичная функция трёх переменных', () => {
  const f = ([a, b, c]) => (a - 2) ** 2 + (b + 3) ** 2 + (c - 0.5) ** 2;
  const { x } = nelderMead(f, [0, 0, 0]);
  assert.ok(Math.abs(x[0] - 2) < 1e-4 && Math.abs(x[1] + 3) < 1e-4 && Math.abs(x[2] - 0.5) < 1e-4);
});
