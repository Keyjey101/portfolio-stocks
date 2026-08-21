'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { statusOf } = require('../src/signals');
const { META } = require('../src/portfolio');

// IRMD: T1 ≤95 достигнут, но 2-й транш — только после Q3 по факту исполнения,
// не по цене. Зелёный свет здесь лгал — нужен янтарный ⏸
const IRMD_UNTIL = { event:'Q3 отчёт', check:'маржа >76%, выпуск 300+ единиц 3870' };

test('⏸ уровень достигнут, но событие не снято — янтарный, не зелёный', () => {
  const s = statusOf(90, { lv: [95, 84, 74], until: IRMD_UNTIL });
  assert.strictEqual(s.c, 'y', 'ждёт события — янтарный');
  assert.ok(/^⏸ T1 ✓ — ждёт/.test(s.s), s.s);
  assert.strictEqual(s.tip, IRMD_UNTIL.check, 'в тултипе — что именно проверить');
});

test('⏸ показывает глубокий достигнутый уровень', () => {
  const s = statusOf(70, { lv: [95, 84, 74], until: IRMD_UNTIL });
  assert.ok(/^⏸ T3 ✓/.test(s.s), s.s);
});

test('уровень НЕ достигнут — until не мешает обычному «ждать»', () => {
  const s = statusOf(120, { lv: [95, 84, 74], until: IRMD_UNTIL });
  assert.strictEqual(s.c, 'd');
  assert.ok(/^ждать 95/.test(s.s), s.s);
});

test('META: у IRMD прописано until-условие', () => {
  assert.ok(META.IRMD.until && META.IRMD.until.event === 'Q3 отчёт');
});
