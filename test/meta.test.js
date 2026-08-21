'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { META } = require('../src/portfolio');

test('GDDY больше не в exit: тезис не сломан, вопрос был во фрагментации', () => {
  assert.strictEqual(META.GDDY.tag, 'quality', 'GDDY — quality, не exit');
  const exitTickers = Object.entries(META).filter(([, m]) => m.tag === 'exit').map(([t]) => t);
  assert.deepEqual(exitTickers, ['AYTU'], 'в exit остаётся только AYTU (продать)');
});
