'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPanel, sanitizePanel } = require('../src/lab/mandate');
const { RULES } = require('../src/portfolio');

const ROWS = [
  { t: 'TSM', tag: 'core', val: 3000, ok: true },
  { t: 'ITOT', tag: 'index', val: 1000, ok: true },
  { t: 'PSN', tag: 'quality', val: 2000, ok: true },
  { t: 'TDG', tag: 'quality', val: 2500, ok: true },
];
const FACTORS = {
  generatedAt: '2026-08-24T00:00:00Z',
  enb: 12,
  aiOrthSmh: 0.40,
  orthBetas: { TSM: { SMH: 0.50 }, PSN: { SMH: 0.1 }, TDG: { SMH: 0.2 } },
};
const THESES = {
  PSN: { state: 'damaged', review: { due: '2020-01-01', reason: 'давно' } },
};

test('buildPanel: AI по тегам и по факторам, кэш, макс. имя, сломанные, ENB', () => {
  const P = buildPanel({ rows: ROWS, total: 8500, cash: 500, factors: FACTORS, thesesItems: THESES, rules: RULES, now: new Date('2026-08-24T12:00:00Z') });
  // теги: ядро 3000/8500 ≈ 35,3% — потолок пробит
  assert.ok(Math.abs(P.aiTags.pct - 3000 / 8500) < 1e-9);
  assert.strictEqual(P.aiTags.c, 'r', 'превышение потолка');
  assert.ok(P.aiTags.excess > 0);
  // скрытая: (3000 + 1000×0.3)/8500
  assert.ok(Math.abs(P.aiTags.hiddenPct - 3300 / 8500) < 1e-9);
  // факторы: эффективная доля = β ядра / медианная β имени ядра
  assert.strictEqual(P.aiFactor.beta, 0.40);
  assert.strictEqual(P.aiFactor.medBeta, 0.50);
  assert.ok(Math.abs(P.aiFactor.effShare - 0.8) < 1e-9);
  assert.ok(P.aiDivergence.gapPct > 0, 'расхождение видно: факторная доля выше теговой');
  // кэш: 500/9000 ≈ 5,6% < 10%
  assert.ok(Math.abs(P.cash.pct - 500 / 9000) < 1e-9);
  assert.strictEqual(P.cash.c, 'o');
  assert.strictEqual(P.cash.short, 8500 * 0.10 - 500);
  // макс. имя: TSM 3000/8500 ≈ 35,3% — пробит
  assert.strictEqual(P.maxName.t, 'TSM');
  assert.strictEqual(P.maxName.c, 'r');
  // сломанные: PSN damaged + просрочен
  assert.deepStrictEqual(P.broken.list, ['PSN']);
  assert.deepStrictEqual(P.broken.overdue, ['PSN']);
  assert.strictEqual(P.broken.c, 'r');
  // ENB
  assert.strictEqual(P.enb.value, 12);
  assert.strictEqual(P.enb.n, 4);
});

test('buildPanel: aiOrthSmh=null (артефакт скрыт) → факторной строки нет', () => {
  const P = buildPanel({ rows: ROWS, total: 8500, cash: 500, factors: { ...FACTORS, aiOrthSmh: null }, thesesItems: {}, rules: RULES });
  assert.strictEqual(P.aiFactor, null);
  assert.strictEqual(P.aiDivergence, null);
});

test('sanitizePanel: проценты остаются, доллары вырезаются', () => {
  const P = buildPanel({ rows: ROWS, total: 8500, cash: 500, factors: FACTORS, thesesItems: THESES, rules: RULES, now: new Date('2026-08-24T12:00:00Z') });
  const G = sanitizePanel(P);
  assert.strictEqual(G.guest, true);
  assert.strictEqual(G.aiTags.val, null);
  assert.strictEqual(G.aiTags.excess, null);
  assert.strictEqual(G.cash.short, null);
  assert.strictEqual(G.maxName.val, null);
  assert.strictEqual(G.broken.val, null);
  assert.strictEqual(G.aiTags.pct, P.aiTags.pct, 'проценты видны');
  assert.strictEqual(G.broken.overdue.length, 1, 'просроченные видны');
});
