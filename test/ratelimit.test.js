'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../src/ratelimit');

test('окно: до лимита пропускает, дальше режет, после окна снова пускает', () => {
  let t = 1000;
  const allow = createLimiter({ now: () => t });
  assert.strictEqual(allow('ip', 3, 100), true);
  assert.strictEqual(allow('ip', 3, 100), true);
  assert.strictEqual(allow('ip', 3, 100), true);
  assert.strictEqual(allow('ip', 3, 100), false);
  t = 1101; // окно истекло
  assert.strictEqual(allow('ip', 3, 100), true);
});

test('ключи считаются независимо', () => {
  const allow = createLimiter({ now: () => 0 });
  allow('a', 1, 1000);
  assert.strictEqual(allow('a', 1, 1000), false);
  assert.strictEqual(allow('b', 1, 1000), true);
});
