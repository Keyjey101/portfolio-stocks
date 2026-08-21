'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { watchStatus } = require('../src/signals');

// ISRG: зона $430–470 → lv [470,450,430], цена $380.86 — ниже зоны,
// система раньше молчала, хотя уровень давно пробит снизу
test('watchStatus: цена ниже всей зоны — янтарный «пересмотреть», не зелёный', () => {
  const s = watchStatus(380.86, [470, 450, 430]);
  assert.strictEqual(s.c, 'y', 'янтарный — зона пробита снизу, тезис надо перепроверить');
  assert.ok(/ниже зоны/.test(s.s), 'текст говорит «ниже зоны»: ' + s.s);
});

test('watchStatus: цена в зоне — зелёные уровни', () => {
  assert.strictEqual(watchStatus(455, [470, 450, 430]).s, '✓ T1 ≤470');
  assert.strictEqual(watchStatus(445, [470, 450, 430]).s, '✓✓ T2 ≤450');
  assert.strictEqual(watchStatus(425, [470, 450, 430]).s, '✓✓✓ T3 ≤430');
});

test('watchStatus: выше зоны — ждать, без уровней — прочерк', () => {
  const wait = watchStatus(520, [470, 450, 430]);
  assert.strictEqual(wait.c, 'd');
  assert.ok(/ждать 470/.test(wait.s), 'показывает ближайший уровень: ' + wait.s);
  assert.strictEqual(watchStatus(520, null).s, '—');
});
