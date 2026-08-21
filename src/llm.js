// Клиент z.ai GLM (OpenAI-совместимый /chat/completions): строгий JSON,
// валидация схемой, ≤2 ретраев с фидбеком, бюджет-лог в data/llm-log.jsonl.
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env');

const ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'data', 'llm-log.jsonl');

const num = (v, dflt) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

function conf() {
  const ENV = loadEnv();
  return {
    key: process.env.ZAI_API_KEY || ENV.ZAI_API_KEY || '',
    base: (process.env.ZAI_BASE_URL || ENV.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4').replace(/\/+$/, ''),
    model: process.env.ZAI_MODEL || ENV.ZAI_MODEL || 'glm-4.6',
  };
}

// schema: {field: 'string'|'number'|'boolean'|'array'|'enum:a,b,c'}
function validate(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'ожидается JSON-объект';
  for (const [k, rule] of Object.entries(schema)) {
    const v = obj[k];
    if (v == null) return `нет поля "${k}"`;
    if (rule === 'string' && typeof v !== 'string') return `поле "${k}" не строка`;
    if (rule === 'number' && typeof v !== 'number') return `поле "${k}" не число`;
    if (rule === 'boolean' && typeof v !== 'boolean') return `поле "${k}" не булево`;
    if (rule === 'array' && !Array.isArray(v)) return `поле "${k}" не массив`;
    if (String(rule).startsWith('enum:')) {
      const allowed = rule.slice(5).split(',');
      if (!allowed.includes(v)) return `поле "${k}" должно быть одним из: ${allowed.join(' | ')}`;
    }
  }
  return null;
}

// срезает ```-заборы и берёт внешнюю {…} конструкцию
function extractJson(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('в ответе нет JSON-объекта');
  return JSON.parse(s.slice(i, j + 1));
}

function logCall(rec) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* лог не должен ломать вызов */ }
}

async function chat(messages, { schema, task = 'chat', t = null, temperature = 0.2, fetchImpl, maxRetries = 2 } = {}) {
  const { key, base, model } = conf();
  if (!key) throw new Error('ZAI_API_KEY не задан (.env)');
  const doFetch = fetchImpl || fetch;
  let attempt = 0, lastErr = '';
  const convo = messages.slice();

  while (attempt <= maxRetries) {
    attempt++;
    let content;
    try {
      const r = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature, messages: convo }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      content = j?.choices?.[0]?.message?.content;
      if (!content) throw new Error('пустой ответ модели');
    } catch (e) {
      lastErr = `сетевая ошибка: ${e.message}`;
      if (attempt > maxRetries) {
        logCall({ task, t, model, ok: false, retries: attempt - 1, error: lastErr });
        throw new Error(`LLM ${task}: ${lastErr}`);
      }
      continue;
    }
    try {
      const obj = extractJson(content);
      const err = schema ? validate(obj, schema) : null;
      if (err) throw new Error(err);
      logCall({ task, t, model, ok: true, retries: attempt - 1 });
      return obj;
    } catch (e) {
      lastErr = `невалидный ответ: ${e.message}`;
      if (attempt > maxRetries) {
        logCall({ task, t, model, ok: false, retries: attempt - 1, error: lastErr });
        throw new Error(`LLM ${task}: не удалось получить валидный JSON (${lastErr})`);
      }
      convo.push({ role: 'assistant', content });
      convo.push({ role: 'user', content: `Твой прошлый ответ ${lastErr}. Верни ТОЛЬКО валидный JSON-объект с нужными полями, без пояснений.` });
    }
  }
  throw new Error('LLM: недостижимая ветка');
}

module.exports = { chat, validate, extractJson };
