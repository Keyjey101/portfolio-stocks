'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('../src/env');

const TMP = path.join(__dirname, '..', 'data', 'cache', 'test.env');

test('loadEnv: парсит KEY=VALUE, режет кавычки, пропускает комментарии', () => {
  fs.mkdirSync(path.dirname(TMP), { recursive: true });
  fs.writeFileSync(TMP, [
    '# комментарий',
    'MC_MONTHLY_USD=250',
    "QUOTED='hello'",
    'DOUBLE="world"',
    'SPACED = 42 ',
    '',
    'not a pair',
  ].join('\n'));
  const env = loadEnv(TMP);
  assert.strictEqual(env.MC_MONTHLY_USD, '250');
  assert.strictEqual(env.QUOTED, 'hello');
  assert.strictEqual(env.DOUBLE, 'world');
  assert.strictEqual(env.SPACED, '42');
  assert.strictEqual(Object.keys(env).length, 4, 'комментарий/пустое/мусор пропущены');
});

test('loadEnv: нет файла — пустой объект', () => {
  assert.deepEqual(loadEnv(path.join(__dirname, 'no-such.env')), {});
});
