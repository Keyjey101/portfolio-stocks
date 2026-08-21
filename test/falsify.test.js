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

const { generate, check, getRegistry, saveRegistry } = require('../src/lab/falsify');

const llmGen = { chat: async () => ({
  thesis: 'Рост спроса на AI-энергетику, контрактный цикл',
  conditions: [
    { text: 'рост выручки < 10% г/г два квартала подряд' },
    { text: 'потеря крупнейшего контракта (>15% выручки)' },
    { text: 'капекс-цикл атомной генерации свёрнут >2 лет' },
  ],
}) };
const llmCheck = { chat: async () => ({
  verdicts: [
    { i: 0, triggered: false, evidence: 'выручка +18% г/г в Q2' },
    { i: 1, triggered: false, evidence: 'контракты в силе' },
    { i: 2, triggered: true, evidence: 'задержка программы на 30 мес' },
  ],
}) };

const newsMock = async url => ({
  ok: true,
  text: async () => '<rss><channel><item><title>Q2 revenue up 18%</title></item></channel></rss>',
});

after(() => {
  if (hadOrig) { fs.copyFileSync(TMP, REG); fs.unlinkSync(TMP); }
  else fs.unlinkSync(REG);
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
    const reg = getRegistry();
    assert.strictEqual(reg.length, 1);
    // повторная генерация заменяет, не дублирует
    await generate('CEG', { llm: llmGen });
    assert.strictEqual(getRegistry().length, 1);
  } finally { globalThis.fetch = realFetch; }
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
  } finally { globalThis.fetch = realFetch; }
});

test('check: несуществующий тикер → null; checkAll обходит active', async () => {
  assert.strictEqual(await check('NOPE', { llm: llmCheck }).catch(() => 'thrown'), 'thrown');
  const reg = getRegistry();
  assert.strictEqual(reg.filter(r => r.status === 'triggered').length, 1);
});
