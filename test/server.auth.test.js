'use strict';
// Интеграция авторизации на живом сервере: PORT=0 (эпемерный порт),
// планировщик выключен, реальный .env изолирован.
process.env.PT_NO_SCHEDULER = '1';
process.env.PORT = '0';
delete process.env.API_PORT;
process.env.APP_PASSWORD = 'integration-pw';

const env = require('../src/env');
env.loadEnv = () => ({});

const { test, after } = require('node:test');
const assert = require('node:assert');
const { start } = require('../src/server');

const { server } = start();
const base = new Promise(resolve => {
  if (server.listening) return resolve(`http://127.0.0.1:${server.address().port}`);
  server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// открытый listen держит процесс — закрываем по завершении набора
after(() => new Promise(r => server.close(r)));

test('гость: статика отдаётся, сессия — без прав, но авторизация включена', async () => {
  const b = await base;
  const s = await (await fetch(b + '/api/session')).json();
  assert.strictEqual(s.owner, false);
  assert.strictEqual(s.auth, true);

  const page = await fetch(b + '/');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /терминал/i);
  assert.match(html, /btnAuth/);
});

test('гость не жмёт кнопки агентов и не видит личные разделы', async () => {
  const b = await base;
  const post = (p, body) => fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.strictEqual((await post('/api/lab/committee', '{"action":"run"}')).status, 401);
  assert.strictEqual((await post('/api/lab/falsify', '{"action":"generate","t":"TSM"}')).status, 401);
  assert.strictEqual((await post('/api/journal', '{"type":"buy"}')).status, 401);
  assert.strictEqual((await fetch(b + '/api/lab/mc')).status, 401);
  assert.strictEqual((await fetch(b + '/api/lab/factors?force=1')).status, 401);
  assert.strictEqual((await fetch(b + '/api/journal/pending')).status, 401);
});

test('логин: неверный пароль 403, верный — cookie и полный доступ', async () => {
  const b = await base;
  const bad = await fetch(b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"nope"}' });
  assert.strictEqual(bad.status, 403);

  const good = await fetch(b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"integration-pw"}' });
  assert.strictEqual(good.status, 200);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /pt_auth=/);

  const s = await (await fetch(b + '/api/session', { headers: { cookie } })).json();
  assert.strictEqual(s.owner, true);

  const pend = await fetch(b + '/api/journal/pending', { headers: { cookie } });
  assert.strictEqual(pend.status, 200); // личный раздел открыт владельцу
});

test('rate limit: серия тяжёлых запросов упирается в 429', async () => {
  const b = await base;
  const statuses = [];
  for (let i = 0; i < 16; i++) {
    const r = await fetch(b + '/api/lab/committee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"run"}' });
    statuses.push(r.status);
  }
  assert.strictEqual(statuses[0], 401, 'первый — отказ доступа, а не лимит');
  assert.ok(statuses.includes(429), 'дальше должен сработать лимiter: ' + statuses.join(','));
});
