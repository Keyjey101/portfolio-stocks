'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// signals.js подгружает tradernet/portfolio, но сети в момент require нет — безопасно
const { yieldSignal, firesOf } = require('../src/signals');

test('yieldSignal: нет данных — отдельное состояние, не зелёный сигнал', () => {
  const s = yieldSignal(null);
  assert.strictEqual(s.ok, false, 'ok=false при полном отсутствии данных');
  assert.strictEqual(s.c, 'd', 'цвет серый, не зелёный');
  const s2 = yieldSignal(Array(10).fill(4.2)); // < 21 точки
  assert.strictEqual(s2.ok, false, 'ok=false при коротком ряду');
});

test('yieldSignal: полноценный ряд помечается ok=true', () => {
  const rising = yieldSignal(Array.from({ length: 25 }, (_, i) => 4.0 + i * 0.013)); // +273 б.п. за месяц
  assert.strictEqual(rising.ok, true);
  assert.strictEqual(rising.c, 'r', 'рост ставок — красный');
  const flat = yieldSignal(Array(25).fill(4.0));
  assert.strictEqual(flat.ok, true);
  assert.strictEqual(flat.c, 'y', 'стабильно — жёлтый');
});

test('firesOf: безданные ставки НЕ засчитываются как сработавший сигнал', () => {
  // регрессия A2: падение ^TNX давало «зелёный» сигнал и раздувало вердикт
  const noData = yieldSignal(null);
  const [fV, fT, fY] = firesOf({ c: 'g' }, { c: 'g' }, noData);
  assert.strictEqual(fV, false);
  assert.strictEqual(fT, false);
  assert.strictEqual(fY, false, 'нет данных по ставкам — сигнал не сработал');
});

test('firesOf: ставки вниз при данных — сигнал сработал', () => {
  const down = yieldSignal(Array.from({ length: 25 }, (_, i) => 4.5 - i * 0.013)); // −273 б.п.
  assert.strictEqual(down.c, 'g');
  const [, , fY] = firesOf({ c: 'g' }, { c: 'g' }, down);
  assert.strictEqual(fY, true);
});
