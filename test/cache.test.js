'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { readCache, writeCache, cacheAgeMs } = require('../src/cache');

const DIR = path.join(__dirname, '..', 'data', 'cache');

test('cache: write → read roundtrip', () => {
  writeCache('test-a', { x: 1, s: 'привет' });
  assert.deepEqual(readCache('test-a', 60e3), { x: 1, s: 'привет' });
});

test('cache: TTL=0 — просрочен', () => {
  writeCache('test-b', { x: 1 });
  assert.strictEqual(readCache('test-b', 0), null);
});

test('cache: нет файла → null без throw', () => {
  assert.strictEqual(readCache('test-missing', 60e3), null);
  assert.strictEqual(cacheAgeMs('test-missing'), null);
});

test('cache: cacheAgeMs растёт', async () => {
  writeCache('test-c', { x: 1 });
  const a = cacheAgeMs('test-c');
  await new Promise(r => setTimeout(r, 30));
  assert.ok(cacheAgeMs('test-c') >= a + 20);
});

after(() => {
  try { for (const f of fs.readdirSync(DIR)) if (f.startsWith('test-')) fs.unlinkSync(path.join(DIR, f)); } catch {}
});
