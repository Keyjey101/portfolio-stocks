'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pTouch } = require('../src/math/timeseries');
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

// грубая MC-оценка P(минимум лог-цены ≤ ln(target/S0)) за 252 шага/год.
// Дискретный мониторинг пропускает внутридневные пробои — сдвигаем барьер
// поправкой Broadie-Glasserman-Kou (β=0.5826·σ√dt), чтобы сравнивать
// с непрерывной аналитической формулой.
function mcTouch(S0, target, muAnn, sigAnn, years, seed, paths = 20000) {
  const g = gaussMaker(lcg(seed));
  const nu = muAnn - sigAnn * sigAnn / 2;
  const steps = Math.round(years * 252);
  const dt = 1 / 252;
  const b = Math.log(target / S0) - 0.5826 * sigAnn * Math.sqrt(dt);
  let hits = 0;
  for (let p = 0; p < paths; p++) {
    let x = 0, hit = false;
    for (let t = 1; t <= steps; t++) {
      x += nu * dt + sigAnn * Math.sqrt(dt) * g();
      if (x <= b) { hit = true; break; }
    }
    if (hit) hits++;
  }
  return hits / paths;
}

test('pTouch: совпадает с Монте-Карло на трёх случаях', () => {
  const cases = [
    [100, 90, 0.05, 0.30, 1],
    [100, 70, 0.05, 0.30, 1],
    [100, 80, 0.02, 0.45, 2],
  ];
  cases.forEach(([s0, tgt, mu, sig, yr], i) => {
    const analytic = pTouch(s0, tgt, mu, sig, yr);
    const mc = mcTouch(s0, tgt, mu, sig, yr, 100 + i);
    assert.ok(Math.abs(analytic - mc) < 0.02,
      `case ${i}: analytic=${analytic.toFixed(3)} mc=${mc.toFixed(3)}`);
  });
});

test('pTouch: граничные случаи', () => {
  assert.strictEqual(pTouch(100, 100, 0.05, 0.3, 1), 1, 'уровень на цене — уже достигнут');
  assert.strictEqual(pTouch(100, 110, 0.05, 0.3, 1), 1, 'уровень выше цены');
  assert.ok(pTouch(100, 95, 0.05, 0.3, 1) > pTouch(100, 80, 0.05, 0.3, 1), 'ближе — вероятнее');
  assert.ok(pTouch(100, 80, 0.05, 0.3, 2) > pTouch(100, 80, 0.05, 0.3, 1), 'дольше — вероятнее');
});
