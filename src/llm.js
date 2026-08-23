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

// ── транспорт: прямой fetch; при сетевом сбое — туннель через локальный прокси
// (тот же механизм, что у Tradernet: ENV TRADERNET_PROXY > кэш > скан портов).
// HTTP-ошибки API (401/429/…) прокси не лечат — фолбэк только на сетевых ошибках.
const { detectProxy, requestViaProxy } = require('./tradernet');

async function postJson(url, headers, body, timeoutMs, { fetchImpl = fetch, net } = {}) {
  const doFetch = fetchImpl;
  const via = net || { detectProxy, requestViaProxy };

  // 1) напрямую
  try {
    const r = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: r.ok, status: r.status, text: await r.text(), via: 'direct' };
  } catch (e) {
    const directErr = e.cause ? (e.cause.code || e.cause.message) : e.message;
    if (fetchImpl !== fetch && !net) throw e; // инжектированный тестовый fetch без net-фолбэка

    // 2) через локальный прокси
    let proxyUrl = null;
    try {
      proxyUrl = await via.detectProxy(new URL(url).hostname);
    } catch { /* прокси не найден */ }
    if (!proxyUrl) {
      throw new Error(`нет маршрута до ${new URL(url).hostname} (прямая ошибка: ${directErr}). Включи VPN/прокси — как для брокера`);
    }
    try {
      const res = await via.requestViaProxy(proxyUrl, url, { method: 'POST', headers, body, timeoutMs });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.body.toString('utf8'), via: 'proxy' };
    } catch (pe) {
      // CONNECT может принимать даже полумёртвый VPN — отличаем «нет прокси» от «данные не идут»
      throw new Error(
        `нет маршрута до ${new URL(url).hostname}: напрямую — ${directErr}; прокси ${proxyUrl} найден, но данные не проходят (${pe.message}). ` +
        'Проверь VPN: подключение/ноду, и что api.z.ai идёт через прокси, а не DIRECT');
    }
  }
}

// Дневной бюджет: каждый сетевой поход в модель (включая ретраи) — +1 к счётчику
// data/llm-budget.json. LLM_DAILY_LIMIT=0/не задан — без лимита.
// Предохранитель от «зажатой кнопки» или зацикленного агента на платном ключе.
const BUDGET_CACHE = 'llm-budget';
const todayKey = () => new Date().toISOString().slice(0, 10);
const dailyLimit = () => {
  const raw = process.env.LLM_DAILY_LIMIT ?? loadEnv().LLM_DAILY_LIMIT;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function budgetState(readCache) {
  const j = readCache ? readCache(BUDGET_CACHE, null) : null;
  return j && j.date === todayKey() ? j : { date: todayKey(), count: 0 };
}

// checkpoint для инъекции в тестах
const budgetIO = {
  read() { return budgetState(require('./cache').readCache); },
  bump(state) { require('./cache').writeCache(BUDGET_CACHE, state); },
};

async function chat(messages, { schema, task = 'chat', t = null, temperature = 0.2, fetchImpl, net, maxRetries = 2 } = {}) {
  const { key, base, model } = conf();
  // бюджет проверяем до ключа: исчерпанный день должен кончаться без сети
  const limit = dailyLimit();
  let budget = budgetIO.read();
  if (limit && budget.count >= limit) {
    throw new Error(`дневной лимит LLM исчерпан (${budget.count}/${limit}) — продолжай завтра или подними LLM_DAILY_LIMIT`);
  }
  if (!key) throw new Error('ZAI_API_KEY не задан (.env)');
  let attempt = 0, lastErr = '';
  const convo = messages.slice();

  while (attempt <= maxRetries) {
    attempt++;
    if (limit) { budget = budgetState(); budget.count++; budgetIO.bump(budget); }
    let content;
    try {
      const r = await postJson(`${base}/chat/completions`, {
        'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
      }, JSON.stringify({ model, temperature, messages: convo }), 90000, { fetchImpl, net });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
      const j = JSON.parse(r.text);
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

module.exports = { chat, validate, extractJson, budgetIO };
