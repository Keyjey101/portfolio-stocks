'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { calibrateLevels } = require('../src/lab/levels');
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

// GBM: μ=5%/год, σ=25%/год, 520 торговых дней
function gbmCloses(seed) {
  const g = gaussMaker(lcg(seed));
  const muD = 0.05 / 252, sigD = 0.25 / Math.sqrt(252);
  let p = 100;
  const closes = [p];
  for (let i = 0; i < 520; i++) { p *= Math.exp(muD - sigD * sigD / 2 + sigD * g()); closes.push(+p.toFixed(4)); }
  return closes;
}

test('calibrateLevels: σ года ≈ 25%, вероятности средних уровней разумные', () => {
  const closes = gbmCloses(3);
  const px = closes.at(-1);
  const cal = calibrateLevels(closes, [px * 0.9, px * 0.82, px * 0.7]);
  assert.ok(Math.abs(cal.sigAnn - 0.25) < 0.04, 'sigAnn=' + cal.sigAnn);
  for (const l of cal.levels) {
    assert.ok(l.p > 0.05 && l.p < 0.95, `P(${l.v})=${l.p} должен быть промежуточным`);
  }
});

test('calibrateLevels: далёкий уровень — «фантазия», близкие — «склеить»', () => {
  const closes = gbmCloses(9);
  const px = closes.at(-1);
  const far = calibrateLevels(closes, [px * 0.9, px * 0.6, px * 0.3]);
  assert.strictEqual(far.fantasy, true, 'уровень 0.3× цены недостижим');
  assert.ok(far.levels[2].p < 0.01);
  const near = calibrateLevels(closes, [px * 0.90, px * 0.88, px * 0.7]); // 2% между T1 и T2 << 1σ≈25%
  assert.ok(near.merge.length >= 1, 'уровни ближе 1σ должны склеиваться');
  assert.ok(near.fantasy === false);
});

test('calibrateLevels: waitCost — прокси издержек ожидания', () => {
  const closes = gbmCloses(21);
  const px = closes.at(-1);
  const cal = calibrateLevels(closes, [px * 0.95, px * 0.85, px * 0.75]);
  assert.ok(typeof cal.waitCost === 'number' && Number.isFinite(cal.waitCost));
  // (1−P)·μ·1·px: μ≈2.5% после шринка, P(0.95) велика → издержки малы, но положительны как метрика
  assert.ok(cal.waitCost > -1 && cal.waitCost < px * 0.05);
  assert.ok(cal.fit && typeof cal.fit.alpha === 'number');
});
