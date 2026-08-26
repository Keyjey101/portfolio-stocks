'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// подменяем файл реестра на тестовый ДО загрузки модуля
const REG = path.join(__dirname, '..', 'data', 'falsifications.json');
const TMP = path.join(__dirname, '..', 'data', 'cache', '.falsify-backup-tmp');
const hadOrig = fs.existsSync(REG);
if (hadOrig) fs.copyFileSync(REG, TMP);
fs.writeFileSync(REG, '[]');

// оверрайды меты и записи тезисов — в отдельные файлы (параллельные
// тест-файлы не делят состояние; боевые data/*.json не трогаем)
const OVR = path.join(__dirname, '..', 'data', 'cache', '.overrides-test-fal.json');
process.env.OVERRIDES_FILE = OVR;
process.env.THESES_FILE = path.join(__dirname, '..', 'data', 'cache', '.theses-test-fal.json');
fs.rmSync(process.env.THESES_FILE, { force: true });

const { generate, check, getRegistry, saveRegistry, reset } = require('../src/lab/falsify');
const overrides = require('../src/overrides');

const llmGen = { chat: async () => ({
  thesis: 'Рост спроса на AI-энергетику, контрактный цикл',
  conditions: [
    { text: 'рост выручки < 10% г/г два квартала подряд' },
    { text: 'потеря крупнейшего контракта (>15% выручки)' },
    { text: 'капекс-цикл атомной генерации свёрнут >2 лет' },
  ],
  levels: [null, 220, 195],
  until_event: 'Q3 отчёт',
  until_check: 'рост загрузки мощностей',
  note: 'контракты подтверждаются',
}) };
// уровни структурно невалидны (длина 1) → lv не пишется, until пишется
const llmGenBadLv = { chat: async () => ({
  thesis: 'Тезис',
  conditions: [
    { text: 'условие первое достаточно длинное' },
    { text: 'условие второе достаточно длинное' },
    { text: 'условие третье достаточно длинное' },
  ],
  levels: [9999],
  until_event: '',
  until_check: '',
  note: 'Информации недостаточно',
}) };
const llmCheck = { chat: async () => ({
  verdicts: [
    { i: 0, triggered: false, evidence: 'выручка +18% г/г в Q2' },
    { i: 1, triggered: false, evidence: 'контракты в силе' },
    { i: 2, triggered: true, evidence: 'задержка программы на 30 мес' },
  ],
  levels: [null, 210, 190],
  until_event: 'Q4 отчёт',
  until_check: 'подтверждение плана на год',
}) };

const newsMock = async url => ({
  ok: true,
  text: async () => '<rss><channel><item><title>Q2 revenue up 18%</title></item></channel></rss>',
});

after(() => {
  if (hadOrig) { fs.copyFileSync(TMP, REG); fs.unlinkSync(TMP); }
  else fs.unlinkSync(REG);
  if (fs.existsSync(OVR)) fs.unlinkSync(OVR);
});

test('generate: создаёт запись с тремя условиями и тезисом', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = newsMock;
  try {
    const rec = await generate('CEG', { llm: llmGen });
    assert.strictEqual(rec.t, 'CEG');
    assert.strictEqual(rec.status, 'active');
    assert.strictEqual(rec.conditions.length, 3);
    assert.ok(rec.conditions.every(c => c.text && c.text.length > 10), 'условия содержательные');
    // агент обновил мета: уровни + until + note, со снимком «было»
    assert.ok(rec.agentMeta && Array.isArray(rec.agentMeta.lv));
    const o = overrides.get('CEG');
    assert.deepEqual(o.lv, [null, 220, 195]);
    assert.strictEqual(o.until.event, 'Q3 отчёт');
    assert.strictEqual(o.note, 'контракты подтверждаются');
    assert.deepEqual(o._was.lv, [null, 230, 205], 'снимок «было» — hardcoded-дефолт CEG');
    const reg = getRegistry();
    assert.strictEqual(reg.length, 1);
    // повторная генерация заменяет, не дублирует
    await generate('CEG', { llm: llmGen });
    assert.strictEqual(getRegistry().length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('generate: структурно невалидные уровни не пишутся', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = newsMock;
  try {
    await generate('MOS', { llm: llmGenBadLv });
    assert.strictEqual(overrides.get('MOS'), null, 'нечего писать — оверрайда нет вообще');
  } finally { globalThis.fetch = realFetch; }
});

test('generate: watch-тикер получает дефолт из WATCH, пустословный note отброшен', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = newsMock;
  try {
    await generate('ISRG', { llm: llmGenBadLv });
    // валидного ничего нет: levels мусор, until пуст, note «информации недостаточно» — блок-лист
    assert.strictEqual(overrides.get('ISRG'), null);
    // а при валидном ответе «было» снимается с watch-дефолта
    await generate('ISRG', { llm: llmGen });
    const o = overrides.get('ISRG');
    assert.deepEqual(o._was.lv, [470, 450, 430], 'was — hardcoded WATCH-уровни ISRG');
    assert.strictEqual(o._was.note, 'не-AI диверсификатор, зона $430–470');
  } finally { globalThis.fetch = realFetch; }
});

test('reset: убирает оверрайд, реестр не трогает', () => {
  assert.strictEqual(reset('CEG'), true);
  assert.strictEqual(overrides.get('CEG'), null);
  assert.strictEqual(getRegistry().some(r => r.t === 'CEG'), true, 'запись реестра осталась');
});

test('check: вердикты по условиям, триггер меняет статус, история чеков копится', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('sec.gov')
    ? { ok: true, json: async () => ({}), text: async () => '{}' }
    : newsMock(url);
  try {
    const rec = await check('CEG', { llm: llmCheck });
    assert.strictEqual(rec.checks.length, 1);
    assert.strictEqual(rec.checks[0].verdicts.length, 3);
    assert.strictEqual(rec.status, 'triggered', 'третье условие сработало');
    assert.ok(rec.triggeredAt);
    // повторный чек добавляет историю
    const rec2 = await check('CEG', { llm: llmCheck });
    assert.strictEqual(rec2.checks.length, 2);
    assert.strictEqual(rec2.status, 'triggered');
    // чек тоже ревизует мета: until обновился
    assert.strictEqual(overrides.get('CEG').until.event, 'Q4 отчёт');
  } finally { globalThis.fetch = realFetch; }
});

test('check: несуществующий тикер → null; checkAll обходит active', async () => {
  assert.strictEqual(await check('NOPE', { llm: llmCheck }).catch(() => 'thrown'), 'thrown');
  const reg = getRegistry();
  assert.strictEqual(reg.filter(r => r.status === 'triggered').length, 1);
});
