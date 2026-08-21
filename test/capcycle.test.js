'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { zscore, buildComposite, stageOf, parseCapex, killSwitchLegs } = require('../src/lab/capcycle');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const toPx = rs => { const p = [100]; rs.forEach((r, i) => p.push(p[i] * Math.exp(r))); return p; };

test('zscore: стандартизует ряд', () => {
  const z = zscore([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(z.at(-1) - 1.41) < 0.01 || z.at(-1) > 1, 'последняя точка выше среднего');
  assert.ok(Math.abs(z.reduce((s, v) => s + v, 0)) < 1e-9);
});

test('buildComposite: полу проводники обгоняют → композит положительный; все ноги в кэше', () => {
  const rnd = lcg(9), T = 260;
  const spy = Array.from({ length: T }, () => rnd() * 0.01);
  const sox = spy.map(v => v + 0.002); // стабильное превосходство
  const flat = Array.from({ length: T }, () => rnd() * 0.008);
  const prices = {
    '^SOX': toPx(sox), SPY: toPx(spy), URA: toPx(flat),
    AMAT: toPx(spy.map(v => v + 0.001)), LRCX: toPx(spy.map(v => v + 0.0012)), KLAC: toPx(spy.map(v => v + 0.0009)),
    TLT: toPx(flat),
  };
  const c = buildComposite(prices);
  assert.ok(c.legs['^SOX/SPY'] > 0.5, 'нога SOX: ' + c.legs['^SOX/SPY']);
  assert.ok(c.composite > 0, 'композит положителен');
  assert.ok(Object.keys(c.legs).length === 4, 'четыре ноги');
  assert.ok(c.stage >= 0 && c.stage <= 3);
});

test('stageOf: границы 0..3', () => {
  assert.strictEqual(stageOf(-1.2), 0);
  assert.strictEqual(stageOf(-0.2), 1);
  assert.strictEqual(stageOf(0.3), 2);
  assert.strictEqual(stageOf(1.5), 3);
});

test('killSwitchLegs: ≥2 ноги с z < −1 → зона', () => {
  assert.strictEqual(killSwitchLegs({ a: -1.5, b: -1.2, c: 0.3, d: 0.1 }).count, 2);
  assert.strictEqual(killSwitchLegs({ a: -1.5, b: 0.2, c: 0.3, d: 0.1 }).count, 1);
});

const CAPEX_FIXTURE = {
  units: {
    USD: [
      // FY2024 годовой
      { start: '2024-07-01', end: '2025-06-30', val: 44580000000, fy: 2025, fp: 'FY', form: '10-K' },
      { start: '2023-07-01', end: '2024-06-30', val: 39740000000, fy: 2024, fp: 'FY', form: '10-K' },
      // кварталы
      { start: '2025-04-01', end: '2025-06-30', val: 12400000000, fy: 2025, fp: 'Q4', form: '10-K' },
      { start: '2025-01-01', end: '2025-03-31', val: 10900000000, fy: 2025, fp: 'Q3', form: '10-Q' },
      { start: '2024-10-01', end: '2024-12-31', val: 9860000000, fy: 2025, fp: 'Q2', form: '10-Q' },
      { start: '2024-07-01', end: '2024-09-30', val: 8890000000, fy: 2025, fp: 'Q1', form: '10-Q' },
    ],
  },
};

test('parseCapex: годовые значения → TTM y/y рост', () => {
  const { annuals, ttm, ttmGrowth } = parseCapex(CAPEX_FIXTURE);
  assert.strictEqual(annuals.length, 2);
  assert.strictEqual(annuals[0].val, 39740000000, 'хронологически: сначала FY2024');
  assert.strictEqual(ttm, 44580000000);
  assert.ok(Math.abs(ttmGrowth - (44580 / 39740 - 1) * 100) < 0.01, 'рост ' + ttmGrowth);
});

test('parseCapex: мусор → null', () => {
  assert.strictEqual(parseCapex({}), null);
  assert.strictEqual(parseCapex({ units: { USD: [] } }), null);
});
