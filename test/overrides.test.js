'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// свой файл оверрайдов на время теста (тест-раннер гоняет файлы параллельно)
const TMP = path.join(__dirname, '..', 'data', 'cache', '.overrides-test-ovr.json');
process.env.OVERRIDES_FILE = TMP;

const ov = require('../src/overrides');

after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });

test('validLv: ровно 3 элемента, число|null, границы 5–95% цены', () => {
  assert.deepEqual(ov.validLv([100, 90, null], 200), [100, 90, null]);
  assert.strictEqual(ov.validLv([100, 90], 200), null, 'короткий массив');
  assert.strictEqual(ov.validLv([100, 90, 5, 1], 200), null, 'длинный массив');
  assert.strictEqual(ov.validLv([100, 90, 5], 200), null, 'уровень ниже 5% цены');
  assert.strictEqual(ov.validLv([100, 221, null], 200), null, 'уровень выше 110% цены');
  assert.deepEqual(ov.validLv([100, 210, null], 200), [100, 210, null], 'зона чуть выше цены допустима (watch/лимиты)');
  assert.strictEqual(ov.validLv(['a', 1, 2], 200), null, 'не числа');
  assert.strictEqual(ov.validLv([null, null, null], 200), null, 'все null — обновления нет');
  assert.deepEqual(ov.validLv([null, 90, 80], null), [null, 90, 80], 'без цены границы не проверяются');
});

test('validUntil: короткое событие + проверка; пустое/мусор → null', () => {
  assert.deepEqual(ov.validUntil('Q3 отчёт', 'маржа >76%'), { event: 'Q3 отчёт', check: 'маржа >76%' });
  assert.strictEqual(ov.validUntil('', 'x'), null);
  assert.strictEqual(ov.validUntil(null), null);
  assert.strictEqual(ov.validUntil('  ab  ', ''), null, 'короче 4 символов');
});

test('applyTo: только whitelist-поля, оверрайд выигрывает у дефолта', () => {
  const def = { tag: 'core', lv: [1, 2, 3], note: 'было', st: null };
  const m = ov.applyTo(def, { lv: [9, 8, 7], note: 'стало', tag: 'exit', st: 'sell', reviewBy: '2099-01-01' });
  assert.deepEqual(m.lv, [9, 8, 7]);
  assert.strictEqual(m.note, 'стало');
  assert.strictEqual(m.tag, 'core', 'tag не переопределяется');
  assert.strictEqual(m.st, null, 'st не переопределяется');
  assert.strictEqual(m.reviewBy, undefined, 'reviewBy не переопределяется');
});

test('set/get/clear: провенанс _at/_src, _was, сброс возвращает дефолт', () => {
  ov.set('TSM', { lv: [350, 330, 310], note: 'свежее', _was: { lv: [380, 355, 340] } }, 'test');
  const g = ov.get('TSM');
  assert.deepEqual(g.lv, [350, 330, 310]);
  assert.deepEqual(g._was.lv, [380, 355, 340]);
  assert.strictEqual(g._src, 'test');
  assert.ok(g._at);

  const merged = ov.merged('TSM', { tag: 'core', lv: [380, 355, 340], note: 'дефолт' });
  assert.deepEqual(merged.lv, [350, 330, 310], 'оверрайд выигрывает');
  assert.strictEqual(merged.note, 'свежее');
  assert.strictEqual(merged.tag, 'core', 'tag из дефолта');

  assert.strictEqual(ov.clear('TSM'), true);
  assert.strictEqual(ov.get('TSM'), null);
  const back = ov.merged('TSM', { tag: 'core', lv: [380, 355, 340] });
  assert.deepEqual(back.lv, [380, 355, 340], 'после clear — дефолт');
  assert.strictEqual(ov.clear('TSM'), false, 'повторный clear — false');
});

test('merged: watch-тикер без оверрайда проходит насквозь', () => {
  const w = ov.merged('ISRG', { t: 'ISRG', note: 'зона', lv: [470, 450, 430] });
  assert.deepEqual(w.lv, [470, 450, 430]);
});
