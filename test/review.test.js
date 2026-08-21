'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { overdueDays } = require('../src/rules');
const { statusOf } = require('../src/signals');
const { rulesCheck } = require('../src/rules');
const { META } = require('../src/portfolio');

const NOW = new Date('2026-08-21T12:00:00');

test('overdueDays: прошло 15 дней с даты пересмотра', () => {
  assert.strictEqual(overdueDays('2026-08-06', NOW), 15);
  assert.strictEqual(overdueDays('2026-09-01', NOW), 0, 'будущая дата — не просрочена');
  assert.strictEqual(overdueDays(null, NOW), 0);
  assert.strictEqual(overdueDays('мусор', NOW), 0);
});

test('⛔ повреждённый тезис с прошедшей датой помечен od (просрочен пересмотр)', () => {
  const s = statusOf(50, { st:'broken', reviewBy:'2026-08-06', check:'стабилизация US-сегмента' }, NOW);
  assert.strictEqual(s.od, true);
  assert.ok(/пересмотр до 06\.08/.test(s.tip), 'тултип называет дату: ' + s.tip);
  const fresh = statusOf(50, { st:'broken', reviewBy:'2026-09-10', check:'x' }, NOW);
  assert.strictEqual(fresh.od, false);
});

test('⏸ GDDY: без уровней, но с датой пересмотра — янтарный «пересмотр до»', () => {
  const s = statusOf(100, { lv:null, reviewBy:'2026-09-01', check:'ROIC ≥20%' }, NOW);
  assert.strictEqual(s.c, 'y');
  assert.ok(/ПЕРЕСМОТР до 01\.09/.test(s.s), s.s);
  assert.strictEqual(s.od, false);
});

test('правила: список просроченных пересмотров у повреждённых тезисов', () => {
  const rows = [
    { t:'ZTS',  tag:'quality', st:'broken', reviewBy:'2026-08-06', val:856, ok:true },
    { t:'LEGN', tag:'lotto',   st:'broken', reviewBy:'2026-08-12', val:800, ok:true },
    { t:'PSN',  tag:'quality', st:'broken', reviewBy:'2026-08-27', val:700, ok:true },
    { t:'TDG',  tag:'quality', st:null,     val:1000, ok:true },
  ];
  const R = { aiCeiling:0.35, cashTargetPct:0.10, maxNamePct:0.084, hiddenAiFactor:0.3 };
  const rules = rulesCheck(rows, 3356, 0, R, NOW);
  assert.deepEqual(rules.broken.overdue.sort(), ['LEGN', 'ZTS'], 'просрочены ZTS и LEGN, PSN — нет');
});

test('META: у всех повреждённых и у GDDY есть reviewBy и check', () => {
  for (const t of ['PSN', 'ZTS', 'NVO', 'LEGN', 'GDDY']) {
    assert.ok(META[t].reviewBy, t + ' без reviewBy');
    assert.ok(META[t].check, t + ' без check');
  }
});
