'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { statusOf } = require('../src/signals');
const { META } = require('../src/portfolio');

test('🔴 продажа: st=sell показывается как ПРОДАТЬ', () => {
  const s = statusOf(2.5, META.AYTU);
  assert.strictEqual(s.c, 'r');
  assert.ok(/ПРОДАТЬ/.test(s.s), s.s);
});

test('⛔ тезис повреждён: st=broken — не «не добирать», а сломан', () => {
  for (const t of ['PSN', 'ZTS', 'NVO', 'LEGN']) {
    const s = statusOf(50, META[t]);
    assert.strictEqual(s.c, 'r', t);
    assert.ok(/ТЕЗИС/.test(s.s), t + ': ' + s.s);
  }
});

test('🔵 фикс части: st=fix — продать часть, а не «не добирать»', () => {
  for (const t of ['CMPS', 'GHRS', 'ATAI', 'DFTX', 'MRKR']) {
    const s = statusOf(50, META[t]);
    assert.strictEqual(s.c, 'b', t + ' должен быть синий');
    assert.ok(/ФИКС/.test(s.s), t + ': ' + s.s);
  }
});

test('★ ITOT: плановый ежемесячный DCA', () => {
  const s = statusOf(120, { lv: [999, 999, 999] });
  assert.strictEqual(s.s, '★ ЕЖЕМЕСЯЧНО');
  assert.strictEqual(s.c, 'g');
});

test('🟢 уровни достигнуты: зелёный сигнал покупки', () => {
  assert.strictEqual(statusOf(366, { lv: [null, 370, 300] }).s, '✓✓ T2 ≤370'); // AVGO
  assert.strictEqual(statusOf(90,  { lv: [95, 84, 74] }).s, '✓ T1 ≤95');
  assert.strictEqual(statusOf(70,  { lv: [95, 84, 74] }).s, '✓✓✓ T3 ≤74');
});

test('уровни не достигнуты — ждать ближайший', () => {
  const s = statusOf(100, { lv: [95, 84, 74] });
  assert.strictEqual(s.c, 'd');
  assert.ok(/^ждать 95/.test(s.s), s.s);
});

test('⚪ без уровней и без флагов — механическое «не добирать», серый, не красный', () => {
  for (const t of ['VTI', 'NVDA', 'INTU', 'META', 'TDG']) {
    const s = statusOf(100, META[t]);
    assert.strictEqual(s.c, 'd', t + ' должен быть серым');
    assert.ok(/НЕ ДОБИРАТЬ/.test(s.s), t + ': ' + s.s);
  }
});

test('приоритет: sell > broken > fix > уровни', () => {
  assert.ok(/ПРОДАТЬ/.test(statusOf(1, { st:'sell', lv:[2,1,0] }).s));
  assert.ok(/ТЕЗИС/.test(statusOf(1, { st:'broken', lv:[2,1,0] }).s));
  assert.ok(/ФИКС/.test(statusOf(1, { st:'fix', lv:[2,1,0] }).s));
  assert.strictEqual(statusOf(1, { lv:[3, 2, 1] }).s, '✓✓✓ T3 ≤1');
});
