// HTTP-роутер: '/' → public/index.html, '/api/data' → JSON, статика public/.
// Два уровня доступа: гость (проценты/вердикты, без кнопок агентов) и владелец
// (APP_PASSWORD → cookie-токен). Под nginx: PORT отдаёт страницы, API_PORT —
// /api/* (location /api/ → 127.0.0.1:API_PORT в конфиге nginx не меняется).
// Зависимостей нет.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { getData, getCalendar, sanitizeForGuest } = require('./signals');
const { runFactors } = require('./lab/factors');
const { runLevels } = require('./lab/levels');
const { runMC } = require('./lab/mc');
const { runDetector } = require('./lab/detector');
const falsify = require('./lab/falsify');
const committee = require('./lab/committee');
const journal = require('./lab/journal');
const baserates = require('./lab/baserates');
const capcycle = require('./lab/capcycle');
const scheduler = require('./scheduler');
const auth = require('./auth');
const { createLimiter } = require('./ratelimit');
const { getMacro } = require('./fred');

const PORT = +(process.env.PORT || 3000);
const API_PORT = +(process.env.API_PORT || 0); // задан и ≠ PORT — поднимаем второй сервер под nginx /api/
const HOST = process.env.HOST || '127.0.0.1';  // наружу — только через reverse-proxy
const PUB = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

// чтение JSON-тела POST (маленького — до 8 КБ)
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 8192) { reject(new Error('тело слишком большое')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  if (!res.headersSent) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  res.end(JSON.stringify(obj));
}

// за nginx адрес клиента — в X-Real-IP; слушаем только 127.0.0.1, так что
// подделать заголовок снаружи нельзя
const clientIp = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '?').replace(/^::ffff:/, '');

const limiter = createLimiter();

async function handle(req, res) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const owner = auth.isOwner(req);

  if (url === '/favicon.ico') { res.writeHead(204).end(); return; }

  if (url === '/lab') {
    fs.readFile(path.join(PUB, 'lab.html'), (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ── сессия/вход/выход ──
  if (url === '/api/session') {
    json(res, 200, { ok: true, owner, auth: auth.enabled() });
    return;
  }
  if (url === '/api/login' && req.method === 'POST') {
    // Secure-флаг: за https-nginx (x-forwarded-proto) или принудительно env-ом
    const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.PT_SECURE_COOKIES === '1';
    try {
      const b = await readBody(req);
      const ok = auth.login(clientIp(req), b.password, res, { secure });
      if (ok) json(res, 200, { ok: true, owner: true });
      else json(res, 403, { ok: false, error: 'неверный пароль или слишком много попыток — попробуй через несколько минут' });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }
  if (url === '/api/logout' && req.method === 'POST') {
    auth.logout(res);
    json(res, 200, { ok: true });
    return;
  }

  if (url.startsWith('/api/')) {
    const ip = clientIp(req);
    // «тяжёлые» запросы: мутации, LLM-вызовы и принудительные пересчёты
    const heavy = req.method !== 'GET' || req.url.includes('force=1') || req.url.includes('backfill=1');
    if (!limiter(ip + (heavy ? ':w' : ':r'), heavy ? 12 : 90, 60e3)) {
      json(res, 429, { ok: false, error: 'слишком часто — подожди минуту' });
      return;
    }
    // гости не жмут кнопки агентов и не форсируют пересчёты (это деньги на LLM)
    if (!owner && heavy) {
      json(res, 401, { ok: false, guest: true, error: 'доступно владельцу — войди через 🔑' });
      return;
    }
    // личное: журнал решений и Монте-Карло-план (суммы довнесений) — только владелец
    if (!owner && (url.startsWith('/api/journal') || url === '/api/lab/mc')) {
      json(res, 401, { ok: false, guest: true, error: 'личный раздел — войди как владелец' });
      return;
    }
  }

  if (url === '/api/macro') {
    try {
      const force = owner && req.url.includes('force=1');
      json(res, 200, await getMacro({ force }));
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/factors') {
    // факторная модель #1/#9: кэш 24 ч на сервере, ?force=1 — пересчитать
    try {
      const force = req.url.includes('force=1');
      const D = await runFactors({ force });
      json(res, 200, D);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/lab/levels') {
    // калибровка уровней #5: GARCH + P(касания), кэш 24 ч.
    // waitCost выведен из размера позиции — гостям недоступен
    try {
      const force = req.url.includes('force=1');
      const D = await runLevels({ force });
      if (!owner && D.items) {
        json(res, 200, { ...D, items: D.items.map(it => ({ ...it, waitCost: null })) });
      } else {
        json(res, 200, D);
      }
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/lab/mc') {
    // Монте-Карло #4: HMM-режимы + блочный бутстрап, кэш 7 дней,
    // симуляции в worker_threads; ?force=1 — пересчитать. Только владелец.
    try {
      const force = req.url.includes('force=1');
      const D = await runMC({ force });
      json(res, 200, D);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/lab/detector') {
    // детектор слома тезиса #2: остатки 2.5σ → LLM-атрибуция;
    // LLM зовётся только по флагам, cooldown 7 дней на тикер
    try {
      const force = req.url.includes('force=1');
      const D = await runDetector({ force });
      json(res, 200, D);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url === '/api/lab/falsify') {
    // заголовки отправляются только после успешной работы:
    // преждевременный writeHead + writeHead(500) в catch = ERR_HTTP_HEADERS_SENT и краш
    try {
      const out = req.method === 'POST'
        ? (() => {
            const p = readBody(req)
              .then(body => body.action === 'check'
                ? falsify.check(body.t)
                : falsify.generate(body.t));
            return p.then(rec => ({ ok: true, rec }));
          })()
        : Promise.resolve({ ok: true, items: falsify.getRegistry() });
      const payload = await out;
      json(res, 200, payload);
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url === '/api/lab/committee') {
    try {
      let payload;
      if (req.method === 'POST') {
        const body = await readBody(req);
        payload = body.action === 'score'
          ? { ok: true, scored: await committee.scoreMatured() }
          : await committee.runCommittee().then(r => ({ ok: true, ...r }));
      } else {
        payload = {
          ok: true,
          roles: committee.ROLES,
          brier: committee.brierByRole(),
          weights: committee.consensusWeights(),
          calibration: committee.calibration(),
          predictions: require('fs').readFileSync(path.join(__dirname, '..', 'data', 'predictions.jsonl'), 'utf8')
            .split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-60).reverse(),
        };
      }
      json(res, 200, payload);
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (url === '/api/journal') {
    try {
      const payload = req.method === 'POST'
        ? await readBody(req).then(b => { journal.addDecision(b); return { ok: true }; })
        : { ok: true, decisions: journal.listDecisions() };
      json(res, 200, payload);
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/journal/pending') {
    // обнаруженные, но не объясненные сделки (дифф снапшота Tradernet)
    json(res, 200, { ok: true, pending: journal.getPending() });
    return;
  }

  if (url === '/api/journal/pending/resolve') {
    try {
      const b = await readBody(req);
      const ok = journal.resolvePending(b.id, b.decision);
      json(res, 200, { ok });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/counterfactuals') {
    // еженедельный расчёт — из кэша планировщика (тяжёлый: цены по всем решениям)
    try {
      const { readCache } = require('./cache');
      const D = readCache('counterfactuals', 6 * 3600e3) || { items: [], advice: null };
      json(res, 200, { ok: true, ...D });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/baserates') {
    try {
      let payload;
      if (req.method === 'POST') {
        const b = await readBody(req);
        payload = { ok: true, result: await baserates.query(String(b.q || '').slice(0, 500)) };
      } else if (req.url.includes('backfill=1')) {
        payload = { ok: true, backfill: await baserates.backfill({}) }; // вся вселенная, одноразово
      } else {
        payload = { ok: true, data: baserates.getAggregates() };
      }
      json(res, 200, payload);
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/capcycle') {
    try {
      let payload;
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'gpu') {
          capcycle.addGpuRent(b.usd);
          payload = { ok: true, data: await capcycle.runCapcycle({ force: true }) };
        } else {
          json(res, 400, { ok: false, error: 'unknown action' });
          return;
        }
      } else {
        const force = req.url.includes('force=1');
        payload = { ok: true, data: await capcycle.runCapcycle({ force }) };
      }
      json(res, 200, payload);
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/calendar') {
    // календарь отчётов: тяжёлый (quoteSummary на каждый тикер) — грузится
    // клиентом отдельно после основных данных; кэш 6 ч на сервере
    try {
      const cal = await getCalendar();
      json(res, 200, cal);
    } catch (e) {
      json(res, 200, { ok: false, items: [] });
    }
    return;
  }

  if (url === '/api/data') {
    try {
      const D = await getData();
      json(res, 200, owner ? D : sanitizeForGuest(D));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // статика из public/ (без выхода за её пределы)
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUB, rel));
  if (file.startsWith(PUB) && MIME[path.extname(file)]) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404).end('not found');
}

function start() {
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    if (!process.env.PT_NO_SCHEDULER) scheduler.start();
    // предохранитель: один необработанный rejection не должен ронять
    // терминал (ошибки в роутах возвращают 500, но защита на случай будущих багов)
    process.on('unhandledRejection', e => console.error('unhandled rejection (сервер жив):', e && e.message));
    const where = HOST === '127.0.0.1' ? 'localhost' : HOST;
    console.log(`\n  Терминал:  http://${where}:${PORT}  ·  лаборатория: http://${where}:${PORT}/lab`
      + (auth.enabled() ? `\n  Вход: 🔑 в шапке (пароль APP_PASSWORD). Без входа — публичный режим без сумм и кнопок.` : `\n  APP_PASSWORD не задан — авторизация выключена (все — владелец).`)
      + (API_PORT && API_PORT !== PORT ? `\n  API-порт для nginx: ${API_PORT} (location /api/ → 127.0.0.1:${API_PORT}).` : '')
      + `\n  Автообновление раз в 90 сек. Ctrl+C для остановки.\n`);
  });

  // второй сервер под существующий конфиг nginx: /api/ уже проксируется на
  // отдельный порт — приложение просто слушает оба, конфиг nginx менять не нужно
  let apiServer = null;
  if (API_PORT && API_PORT !== PORT) {
    apiServer = http.createServer(handle).listen(API_PORT, HOST);
  }
  return { server, apiServer };
}

module.exports = { start, handle };
