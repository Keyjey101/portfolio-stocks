'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { rulesCheck } = require('../src/rules');

// фиксстура повторяет реальную книгу пользователя (2026-08-21):
// AI-ядро $6 233 = 36,0% при потолке 35%, кэш $1 000 = 5,5% (цель 10%),
// макс. имя TDG $1 190 = 6,9% (потолок 8,4%), повреждённые $1 656 = 9,6%
function book() {
  const rows = [
    { t:'TSM',  tag:'core',    st:null,     val:1100, ok:true },
    { t:'AVGO', tag:'core',    st:null,     val:1100, ok:true },
    { t:'CEG',  tag:'core',    st:null,     val:1100, ok:true },
    { t:'NOW',  tag:'core',    st:null,     val:1100, ok:true },
    { t:'NVDA', tag:'core',    st:null,     val:900,  ok:true },
    { t:'MRVL', tag:'core',    st:null,     val:933,  ok:true },
    { t:'PSN',  tag:'quality', st:'broken', val:800,  ok:true },
    { t:'ZTS',  tag:'quality', st:'broken', val:856,  ok:true },
    { t:'TDG',  tag:'quality', st:null,     val:1190, ok:true },
    { t:'VTI',  tag:'index',   st:null,     val:340,  ok:true },
    // остаток книги — много мелких позиций, ни одна не больше TDG
    ...Array.from({ length: 8 }, (_, i) => ({ t:'F' + i, tag:'quality', st:null, val:985, ok:true })),
  ];
  const total = rows.reduce((s, r) => s + r.val, 0); // 17 299
  return { rows, total, cash: 1000 };
}

test('AI-ядро: 36,0% против потолка 35% — красное превышение в долларах', () => {
  const { rows, total, cash } = book();
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck(rows, total, cash, R);
  assert.ok(Math.abs(rules.ai.pct - 0.3603) < 0.0005, '36,0%: ' + (rules.ai.pct * 100).toFixed(2));
  assert.strictEqual(rules.ai.c, 'r');
  assert.ok(Math.abs(rules.ai.excess - 178.35) < 1, 'превышение ≈ $178: ' + rules.ai.excess.toFixed(1));
});

test('AI скрытая бета: +30% индексов второй строкой', () => {
  const { rows, total, cash } = book();
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck(rows, total, cash, R);
  assert.ok(Math.abs(rules.ai.hiddenPct - 0.3662) < 0.0005, '36,6%: ' + (rules.ai.hiddenPct * 100).toFixed(2));
});

test('кэш: 5,5% при цели 10% — оранжевый недобор ≈ $730', () => {
  const { rows, total, cash } = book();
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck(rows, total, cash, R);
  assert.ok(Math.abs(rules.cash.pct - 0.0546) < 0.0005, '5,5%: ' + (rules.cash.pct * 100).toFixed(2));
  assert.strictEqual(rules.cash.c, 'o');
  assert.ok(Math.abs(rules.cash.short - 729.9) < 1, 'недобор ≈ $730: ' + rules.cash.short.toFixed(1));
});

test('макс. имя: TDG 6,9% < 8,4% — зелёное', () => {
  const { rows, total, cash } = book();
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck(rows, total, cash, R);
  assert.strictEqual(rules.max.t, 'TDG');
  assert.ok(Math.abs(rules.max.pct - 0.0688) < 0.0005, '6,9%: ' + (rules.max.pct * 100).toFixed(2));
  assert.strictEqual(rules.max.c, 'g');
});

test('повреждённые тезисы: 9,6% ($1 656) — оранжевое', () => {
  const { rows, total, cash } = book();
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck(rows, total, cash, R);
  assert.ok(Math.abs(rules.broken.pct - 0.0957) < 0.0005, '9,6%: ' + (rules.broken.pct * 100).toFixed(2));
  assert.strictEqual(rules.broken.val, 1656);
  assert.strictEqual(rules.broken.c, 'o');
});

test('пустая книга не делит на ноль', () => {
  const R = { aiCeiling: 0.35, cashTargetPct: 0.10, maxNamePct: 0.084, hiddenAiFactor: 0.3 };
  const rules = rulesCheck([], 0, 0, R);
  assert.strictEqual(rules.ai.c, 'g');
  assert.strictEqual(rules.max.t, null);
});
