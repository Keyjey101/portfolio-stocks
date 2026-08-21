'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { parseEarnings } = require('../src/yahoo');

const NOW = Date.parse('2026-08-21T12:00:00Z');

function qsum(epochSec) {
  return {
    quoteSummary: {
      result: [{
        calendarEvents: {
          earnings: { earningsDate: [{ raw: epochSec, fmt: 'x' }] },
        },
      }],
    },
  };
}

test('будущий отчёт в пределах 30 дней — берётся, days до него', () => {
  const e = parseEarnings(qsum(Date.parse('2026-08-26T12:00:00Z') / 1000), NOW);
  assert.ok(e, 'отчёт должен быть');
  assert.strictEqual(e.days, 5);
});

test('уже отчитались — пропускается', () => {
  assert.strictEqual(parseEarnings(qsum(Date.parse('2026-08-10T12:00:00Z') / 1000), NOW), null);
});

test('дальше 30 дней — вне ленты', () => {
  assert.strictEqual(parseEarnings(qsum(Date.parse('2026-12-01T12:00:00Z') / 1000), NOW), null);
});

test('нет calendarEvents — null, не ошибка', () => {
  assert.strictEqual(parseEarnings({ quoteSummary: { result: [{}] } }, NOW), null);
  assert.strictEqual(parseEarnings(null, NOW), null);
});

test('из двух дат берётся ближайшая', () => {
  const j = { quoteSummary: { result: [{ calendarEvents: { earnings: {
    earningsDate: [
      { raw: Date.parse('2026-09-15T12:00:00Z') / 1000 },
      { raw: Date.parse('2026-08-27T12:00:00Z') / 1000 },
    ] } } }] } };
  const e = parseEarnings(j, NOW);
  assert.strictEqual(e.days, 6);
});
