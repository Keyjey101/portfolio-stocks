'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { META } = require('../src/portfolio');

test('GDDY больше не в exit: тезис не сломан, вопрос был во фрагментации', () => {
  assert.strictEqual(META.GDDY.tag, 'quality', 'GDDY — quality, не exit');
  const exitTickers = Object.entries(META).filter(([, m]) => m.tag === 'exit').map(([t]) => t);
  assert.deepEqual(exitTickers, ['AYTU'], 'в exit остаётся только AYTU (продать)');
});

test('lab.js: слушатели кнопок вешаются всегда, lockGuest не в условии', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'lab.js'), 'utf8');
  assert.doesNotMatch(src, /!lockGuest\(/, 'инверсия lockGuest лишает владельца обработчика');
  assert.doesNotMatch(src, /&&\s*lockGuest\(/, 'lockGuest в условии теряет обработчик при гонке с /api/session');
  assert.doesNotMatch(src, /\|\|\s*lockGuest\(/, 'lockGuest в условии теряет обработчик при гонке с /api/session');
});
