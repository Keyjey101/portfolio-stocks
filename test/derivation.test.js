'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  mosForDamaged, fairRange, attractiveZone, enforceSpacing, deriveDamaged,
  suggestMergedGrid, suggestReplacement, needsRederive,
} = require('../src/lab/derivation');

test('deriveDamaged: эталон ZTS из спецификации — fair $83–104, MoS 30%, зона $58–72', () => {
  const d = deriveDamaged({ eps: 6.90, multLow: 12, multHigh: 15, damagedPillars: ['ценовая власть', 'рост'], sigmaUsd: 4 });
  assert.ok(Math.abs(d.fair.low - 82.8) < 0.01, 'fair low: ' + d.fair.low);
  assert.ok(Math.abs(d.fair.high - 103.5) < 0.01, 'fair high: ' + d.fair.high);
  assert.strictEqual(d.zone.mos, 0.30, 'две задетые опоры → MoS 30%');
  assert.ok(Math.abs(d.t1 - 103.5 * 0.7) < 0.5, 'T1 = attractive_high ≈ 72.4: ' + d.t1);
  assert.ok(Math.abs(d.t3 - 82.8 * 0.7) < 0.5, 'T3 = attractive_low ≈ 58: ' + d.t3);
  assert.ok(d.t1 > d.t2 && d.t2 > d.t3, 'порядок T1 > T2 > T3');
  assert.ok(d.basis.includes('MoS 30%') && d.basis.includes('12.0–15.0x'), 'basis прослеживаем: ' + d.basis);
});

test('deriveDamaged: haircut при повторном срезе гайденса; мусорные якоря — честная ошибка', () => {
  const f = fairRange({ eps: 6.90, multLow: 12, multHigh: 15, haircutPct: 5 });
  assert.ok(Math.abs(f.epsUsed - 6.555) < 0.001, 'EPS после haircut: ' + f.epsUsed);
  assert.ok(f.low < 82.8, 'диапазон ниже');
  assert.ok(deriveDamaged({ eps: 0, multLow: 12, multHigh: 15 }).error, 'нет EPS — нет вывода');
  assert.ok(deriveDamaged({ eps: 5, multLow: 20, multHigh: 10 }).error, 'перевёрнутый мультипликатор — ошибка');
});

test('mosForDamaged: 1→20%, 2→30%, 3+→40%', () => {
  assert.strictEqual(mosForDamaged(1), 0.20);
  assert.strictEqual(mosForDamaged(2), 0.30);
  assert.strictEqual(mosForDamaged(3), 0.40);
  assert.strictEqual(mosForDamaged(7), 0.40);
});

test('enforceSpacing: раздвигает слипшиеся уровни на 0.75σ, якорь — средний', () => {
  const out = enforceSpacing([100, 99, 98], 5);
  assert.deepStrictEqual(out, [104, 99, 94]);
  // уже разведённые не сжимаются
  assert.deepStrictEqual(enforceSpacing([100, 90, 80], 5), [100, 90, 80]);
  // неупорядоченный вход нормализуется
  assert.deepStrictEqual(enforceSpacing([98, 100, 99], 5), [104, 99, 94]);
  // null-уровни не трогаются
  assert.deepStrictEqual(enforceSpacing([null, 90, 80], 5), [null, 90, 80]);
});

test('suggestMergedGrid: сетка 0.75σ вокруг медианного уровня', () => {
  const g = suggestMergedGrid([380, 370, 360], 100);
  assert.strictEqual(g.anchor, 370);
  assert.deepStrictEqual(g.grid, [445, 370, 295]);
  assert.strictEqual(suggestMergedGrid([null, null, null], 100), null);
});

test('suggestReplacement: сканирует вниз от цены до P(касания) ≥ 10%', () => {
  const fakePTouch = (px, cand) => (cand > 80 ? 0.02 : 0.15); // ниже 80 — достижимо
  const r = suggestReplacement({ px: 100, level: 40, muAnn: 0, sigAnn: 0.3, pTouch: fakePTouch, targetP: 0.10 });
  assert.ok(r && r.level > 75 && r.level <= 80, 'первый достижимый кандидат: ' + (r && r.level));
  assert.strictEqual(suggestReplacement({ px: 100, level: 0, muAnn: 0, sigAnn: 0.3, pTouch: fakePTouch }), null, 'без уровня нет замены');
});

test('needsRederive: |Δцены| > 25% от derived_at', () => {
  const rec = { levels: { px_at: 100 } };
  assert.strictEqual(needsRederive(rec, 126), true);
  assert.strictEqual(needsRederive(rec, 74), true);
  assert.strictEqual(needsRederive(rec, 120), false);
  assert.strictEqual(needsRederive({ levels: null }, 999), false);
});

test('attractiveZone: запас за риск применяется к обоим краям', () => {
  const z = attractiveZone({ low: 100, high: 200 }, 0.3);
  assert.ok(Math.abs(z.low - 70) < 1e-9 && Math.abs(z.high - 140) < 1e-9);
  assert.ok(Math.abs(z.mid - 105) < 1e-9);
});
