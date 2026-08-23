'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const llm = require('../src/llm');

test('дневной лимит LLM: исчерпан — вызов падает до похода в сеть', async () => {
  process.env.LLM_DAILY_LIMIT = '1';
  const orig = llm.budgetIO.read;
  llm.budgetIO.read = () => ({ date: new Date().toISOString().slice(0, 10), count: 1 });
  try {
    await assert.rejects(
      llm.chat([{ role: 'user', content: 'привет' }], { schema: { a: 'number' } }),
      /дневной лимит LLM исчерпан/
    );
  } finally {
    llm.budgetIO.read = orig;
    delete process.env.LLM_DAILY_LIMIT;
  }
});

test('лимит не задан (0/пусто) — бюджет не мешает', () => {
  delete process.env.LLM_DAILY_LIMIT;
  // chat упадёт дальше по другой причине (нет ключа/сети), но не «лимит исчерпан»
  return llm.chat([{ role: 'user', content: 'hi' }], {})
    .then(() => assert.fail('должен был упасть'))
    .catch(e => assert.doesNotMatch(e.message, /лимит/));
});
