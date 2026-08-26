'use strict';
// Журнальный логгер: дедуп повтора, место падения из стека, файлов не создаёт.
const { test } = require('node:test');
const assert = require('node:assert');

test('log: первая беда пишется, повтор молчит, после TTL — со счётчиком', () => {
  const log = require('../src/log');
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const boom = () => { throw new Error('сломалось'); };
    let first = null;
    try { boom(); } catch (e) { first = e; }

    assert.strictEqual(log.warn('ctx-тест', first), true, 'первое — в журнал');
    assert.strictEqual(log.warn('ctx-тест', first), false, 'повтор молчит');
    assert.strictEqual(log.warn('ctx-тест', first), false, 'и ещё раз молчит');
    assert.strictEqual(lines.length, 1, 'ровно одна строка');
    assert.ok(lines[0].includes('[warn] ctx-тест: сломалось'), 'контекст и сообщение на месте');
    assert.ok(/log\.test\.js:\d+/.test(lines[0]), 'место падения из стека приложено');
  } finally {
    console.error = orig;
  }
});
