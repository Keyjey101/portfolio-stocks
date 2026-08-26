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
const theses = require('./lab/theses');
const { runDerive } = require('./lab/derivation');
const mandate = require('./lab/mandate');
const { queueView } = require('./lab/calendar');
const { runBuyCheck } = require('./lab/buycheck');
const scheduler = require('./scheduler');
const auth = require('./auth');
const { createLimiter } = require('./ratelimit');
const { getMacro } = require('./fred');
const equity = require('./equity/orchestrator');
const scanner = require('./equity/scanner');
const { SECTORS } = require('./equity/universe');

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
// тяжёлые эндпоинты оценки: 5 req/min (спека 1 §1.4)
const eqLimiter = createLimiter();

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

  // ── страницы оценки акций: только владелец (гостю — экран с паролем) ──
  if (url === '/stock-analysis' || url === '/market-scanner') {
    if (!auth.enabled() || owner) {
      const file = url === '/stock-analysis' ? 'analysis.html' : 'scanner.html';
      fs.readFile(path.join(PUB, file), (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    } else {
      fs.readFile(path.join(PUB, 'gate.html'), (err, data) => {
        if (err) { res.writeHead(500).end('gate error'); return; }
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }
    return;
  }
  // список секторов для фильтра сканера (страница отдаёт вместе с разметкой)
  if (url === '/api/equity/sectors') {
    json(res, 200, { ok: true, sectors: SECTORS });
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

  // ── оценка акций (docs/spec-replica): только владелец; тяжёлые — 5/мин ──
  const eqDenied = (code, err) => json(res, code, { ok: false, error: err });
  let m;
  if ((m = url.match(/^\/api\/equity\/analyze\/([A-Za-z0-9.\-]+)\/stream$/))) {
    if (!owner) { eqDenied(401, 'доступно владельцу — войди через 🔑'); return; }
    const ip = clientIp(req);
    if (!eqLimiter(ip + ':a', 5, 60e3)) { eqDenied(429, 'слишком часто — не чаще 5 анализов в минуту'); return; }
    const ticker = m[1].toUpperCase();
    const type = req.url.includes('type=dividend') ? 'dividend' : 'equity';
    const force = /[?&]force=1|[?&]force=true/.test(req.url);
    const started = equity.startAnalysis(ticker, { type, force });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const HOUR_S = 3600;
    const nowS = Math.floor(Date.now() / 1000);
    let lastWrite = Date.now();
    const write = obj => {
      try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); lastWrite = Date.now(); } catch { /* клиент отвалился — анализ жив */ }
    };
    // heartbeat: если строк не было 15 с — ': ka' каждую секунду (спека 1 §1.4)
    const hb = setInterval(() => {
      if (Date.now() - lastWrite > 15000) { try { res.write(': ka\n\n'); } catch {} }
    }, 1000);
    req.on('close', () => clearInterval(hb));
    if (started.fromCache) {
      const ageS = Math.floor((require('./cache').cacheAgeMs(started.cacheName) || 0) / 1000);
      write({ step: 'result', status: 'done', data: started.result,
        _cache: { hit: true, created_at: nowS - ageS, expires_at: nowS - ageS + HOUR_S } });
      clearInterval(hb);
      res.end();
      return;
    }
    const run = started.run;
    // безпотеряная подписка: sync() дочитывает кадры по индексу
    let sent = 0;
    const sync = () => { while (sent < run.frames.length) write(run.frames[sent++]); };
    run.subs.add(sync);
    sync();
    run.promise.then(
      () => { clearInterval(hb); try { res.end(); } catch {} },
      () => { clearInterval(hb); try { res.end(); } catch {} },
    );
    req.on('close', () => { run.subs.delete(sync); clearInterval(hb); });
    return;
  }
  if ((m = url.match(/^\/api\/equity\/analyze\/([A-Za-z0-9.\-]+)\/result$/))) {
    // восстановление после обрыва (08 §8.1): только чтение кэша, MISS → 204
    if (!owner) { eqDenied(401, 'доступно владельцу'); return; }
    const type = req.url.includes('type=dividend') ? 'dividend' : 'equity';
    const { data } = equity.cachedResult(m[1], type);
    if (!data) { res.writeHead(204).end(); return; }
    json(res, 200, { step: 'result', status: 'done', data });
    return;
  }
  if (url === '/api/equity/scan' && req.method === 'POST') {
    if (!owner) { eqDenied(401, 'доступно владельцу — войди через 🔑'); return; }
    const ip = clientIp(req);
    if (!eqLimiter(ip + ':s', 5, 60e3)) { eqDenied(429, 'слишком часто — не чаще 5 сканов в минуту'); return; }
    try {
      const b = await readBody(req);
      const out = scanner.startScan({ ...b, force: !!b.force });
      json(res, 202, { data: { scanId: out.scanId, scanType: out.params.scanType, estimatedSeconds: out.estimatedSeconds, cached: !!out.cached } });
    } catch (e) { eqDenied(500, e.message); }
    return;
  }
  if ((m = url.match(/^\/api\/equity\/scan\/([A-Za-z0-9_\-]+)\/status$/))) {
    if (!owner) { eqDenied(401, 'доступно владельцу'); return; }
    const st = scanner.getStatus(m[1]);
    if (!st) { eqDenied(404, 'скан не найден'); return; }
    json(res, 200, { data: st });
    return;
  }
  if ((m = url.match(/^\/api\/equity\/scan\/([A-Za-z0-9_\-]+)\/results$/))) {
    if (!owner) { eqDenied(401, 'доступно владельцу'); return; }
    const r = scanner.getResults(m[1]);
    if (!r) { eqDenied(404, 'скан не найден'); return; }
    if (r.notReady) { eqDenied(400, 'скан ещё не завершён'); return; }
    json(res, 200, { data: r });
    return;
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
                : body.action === 'reset'
                  ? Promise.resolve({ cleared: falsify.reset(body.t) })
                  : falsify.generate(body.t));
            return p.then(rec => ({ ok: true, rec }));
          })()
        : Promise.resolve({ ok: true, items: falsify.getRegistry(), ov: require('./overrides').all() });
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
          bss: committee.bssByRole(),
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

  if (url === '/api/lab/theses') {
    // машина состояний тезиса (#М1) + очередь пересмотров (#М3):
    // GET — чтение (гостям можно: денег в записях нет),
    // POST — ручной переход/перевывод (владелец, LLM по триггеру)
    try {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (b.action === 'derive') {
          const out = await runDerive(String(b.t || '').toUpperCase());
          json(res, 200, { ok: true, derive: out, rec: theses.get(b.t) });
        } else {
          const r = await theses.applyManual(b.t, b.to, b.reason || '');
          json(res, 200, { ok: true, ...r });
        }
      } else {
        json(res, 200, {
          ok: true,
          items: theses.listAll(),
          queue: await queueView({ calendarLoader: getCalendar }),
        });
      }
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/mandate') {
    // движок ограничений мандата (#М4): первым экраном терминала;
    // гостям — проценты без долларов
    try {
      const P = await mandate.runMandate();
      json(res, 200, { ok: true, panel: owner ? P : mandate.sanitizePanel(P) });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url === '/api/lab/buycheck') {
    // «стоит ли покупать X» (#М5): владелец, LLM по ручному триггеру
    try {
      const b = await readBody(req);
      const out = await runBuyCheck({ t: b.t, usd: b.usd });
      json(res, 200, { ok: true, result: out });
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
  // префлайт: без записи в data/ журнал и все кэши молча падают с EACCES —
  // говорим об этом одной строкой при старте, а не россыпью в логах планировщика
  const DATA = path.join(__dirname, '..', 'data');
  try {
    fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });
    fs.accessSync(DATA, fs.constants.W_OK);
  } catch (e) {
    const who = require('os').userInfo().username || 'www-data';
    console.error(`\n  ⚠ Нет прав на запись в ${DATA} (${e.code || e.message}).`
      + `\n    Журнал и кэши работать не будут. Лечение от root:`
      + `\n      chown -R ${who}:${who} ${DATA}\n`);
  }
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    if (!process.env.PT_NO_SCHEDULER) scheduler.start();
    // предохранитель: один необработанный rejection не должен ронять
    // терминал (ошибки в роутах возвращают 500, но защита на случай будущих багов)
    process.on('unhandledRejection', e => console.error('unhandled rejection (сервер жив):', e && e.message));
    const where = HOST === '127.0.0.1' ? 'localhost' : HOST;
    console.log(`\n  Терминал:  http://${where}:${PORT}  ·  лаборатория: http://${where}:${PORT}/lab`
      + `\n  Оценка акций (владелец): /stock-analysis · сканер сектора: /market-scanner`
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
