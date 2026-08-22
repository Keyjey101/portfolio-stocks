'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chat } = require('../src/llm');

const LOG = path.join(__dirname, '..', 'data', 'llm-log.jsonl');

function resp(content) {
  const payload = { choices: [{ message: { content } }] };
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

const SCHEMA = {
  verdict: 'enum:beta_move,idiosyncratic_temporary,thesis_damage',
  reason: 'string',
  confidence: 'number',
};

test('chat: валидный JSON с первого раза', async () => {
  const calls = [];
  const res = await chat([{ role: 'user', content: 'дай JSON' }], {
    schema: SCHEMA,
    task: 'test-ok',
    fetchImpl: async (url, opts) => {
      calls.push(1);
      return resp('{"verdict":"beta_move","reason":"сектор упал","confidence":0.8}');
    },
  });
  assert.strictEqual(res.verdict, 'beta_move');
  assert.strictEqual(res.confidence, 0.8);
  assert.strictEqual(calls.length, 1);
});

test('chat: невалидный ответ → ретрай с фидбеком → валидный', async () => {
  const bodies = [];
  const replies = ['ой, не могу', '```json\n{"verdict":"thesis_damage","reason":"гайденс срезан","confidence":0.9}\n```'];
  let i = 0;
  const res = await chat([{ role: 'user', content: '?' }], {
    schema: SCHEMA,
    task: 'test-retry',
    fetchImpl: async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return resp(replies[i++]);
    },
  });
  assert.strictEqual(res.verdict, 'thesis_damage');
  assert.strictEqual(bodies.length, 2, 'был один ретрай');
  const lastMsg = bodies[1].messages.at(-1);
  assert.ok(String(lastMsg.content).includes('невалидный'), 'ретрай содержит фидбек об ошибке');
});

test('chat: три провала → throw; температура и модель прокинуты', async () => {
  let calls = 0;
  await assert.rejects(
    chat([{ role: 'user', content: '?' }], {
      schema: SCHEMA,
      task: 'test-fail',
      fetchImpl: async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        assert.strictEqual(body.temperature, 0.2);
        assert.ok(body.model);
        return resp('мусор' + calls);
      },
    }),
    /не удалось получить/
  );
  assert.strictEqual(calls, 3, '1 попытка + 2 ретрая');
});

after(() => {
  // чистим тестовые записи лога
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
      .filter(l => !l.includes('"task":"test-'));
    fs.writeFileSync(LOG, lines.length ? lines.join('\n') + '\n' : '');
  } catch {}
});

test('chat: бюджет-лог пишется', async () => {
  const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  await chat([{ role: 'user', content: 'json' }], {
    schema: SCHEMA,
    task: 'test-log',
    fetchImpl: async () => resp('{"verdict":"beta_move","reason":"x","confidence":0.5}'),
  });
  const after = fs.readFileSync(LOG, 'utf8');
  const added = after.length > before.length;
  assert.ok(added, 'лог вырос');
  const rec = JSON.parse(after.trim().split('\n').pop());
  assert.strictEqual(rec.task, 'test-log');
  assert.strictEqual(rec.ok, true);
});

test('chat: прямой fetch упал в сеть → фолбэк через прокси-туннель', async () => {
  // регрессия: api.z.ai недоступен напрямую (IPv6-чёрная дыра/DPI),
  // запрос должен уйти через локальный прокси как у Tradernet
  const badFetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw e; };
  const payload = JSON.stringify({ choices: [{ message: { content: '{"verdict":"beta_move","reason":"ок","confidence":0.7}' } }] });
  const net = {
    detectProxy: async host => {
      assert.strictEqual(host, 'api.z.ai', 'проба туннеля до целевого хоста');
      return 'http://127.0.0.1:7890';
    },
    requestViaProxy: async (proxyUrl, url) => {
      assert.strictEqual(proxyUrl, 'http://127.0.0.1:7890');
      assert.ok(String(url).includes('/chat/completions'));
      return { status: 200, body: Buffer.from(payload) };
    },
  };
  const res = await chat([{ role: 'user', content: '?' }], {
    schema: SCHEMA, task: 'test-proxy', fetchImpl: badFetch, net,
  });
  assert.strictEqual(res.verdict, 'beta_move');
});

test('chat: сети нет и прокси не найден → понятная ошибка про VPN', async () => {
  const badFetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw e; };
  const net = { detectProxy: async () => null, requestViaProxy: async () => { throw new Error('не должен зваться'); } };
  await assert.rejects(
    chat([{ role: 'user', content: '?' }], { schema: SCHEMA, task: 'test-noproxy', fetchImpl: badFetch, net }),
    /включи VPN\/прокси|нет маршрута/i
  );
});

test('chat: прокси найден, но данные не идут → диагноз «полумёртвый VPN»', async () => {
  const badFetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw e; };
  const net = {
    detectProxy: async () => 'http://127.0.0.1:2080',
    requestViaProxy: async () => { throw new Error('пустой ответ'); },
  };
  await assert.rejects(
    chat([{ role: 'user', content: '?' }], { schema: SCHEMA, task: 'test-deadproxy', fetchImpl: badFetch, net }),
    /данные не проходят|DIRECT/
  );
});
