// HTTP-роутер: '/' → public/index.html, '/api/data' → JSON,
// статика public/ (style.css, app.js). Зависимостей нет.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { getData, getCalendar } = require('./signals');
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

const PORT = +(process.env.PORT || 3000);
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

function start() {
  http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);

    if (url === '/favicon.ico') { res.writeHead(204).end(); return; }

    if (url === '/lab') {
      fs.readFile(path.join(PUB, 'lab.html'), (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    if (url === '/api/lab/factors') {
      // факторная модель #1/#9: кэш 24 ч на сервере, ?force=1 — пересчитать
      try {
        const force = req.url.includes('force=1');
        const D = await runFactors({ force });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(D));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url === '/api/lab/levels') {
      // калибровка уровней #5: GARCH + P(касания), кэш 24 ч
      try {
        const force = req.url.includes('force=1');
        const D = await runLevels({ force });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(D));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url === '/api/lab/mc') {
      // Монте-Карло #4: HMM-режимы + блочный бутстрап, кэш 7 дней,
      // симуляции в worker_threads; ?force=1 — пересчитать
      try {
        const force = req.url.includes('force=1');
        const D = await runMC({ force });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(D));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url === '/api/lab/detector') {
      // детектор слома тезиса #2: остатки 2.5σ → LLM-атрибуция;
      // LLM зовётся только по флагам, cooldown 7 дней на тикер
      try {
        const force = req.url.includes('force=1');
        const D = await runDetector({ force });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(D));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/journal') {
      try {
        const payload = req.method === 'POST'
          ? await readBody(req).then(b => { journal.addDecision(b); return { ok: true }; })
          : { ok: true, decisions: journal.listDecisions() };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/journal/pending') {
      // обнаруженные, но не объясненные сделки (дифф снапшота Tradernet)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, pending: journal.getPending() }));
      return;
    }

    if (url === '/api/journal/pending/resolve') {
      try {
        const b = await readBody(req);
        const ok = journal.resolvePending(b.id, b.decision);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/lab/counterfactuals') {
      // еженедельный расчёт — из кэша планировщика (тяжёлый: цены по всем решениям)
      try {
        const { readCache } = require('./cache');
        const D = readCache('counterfactuals', 6 * 3600e3) || { items: [], advice: null };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...D }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
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
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
            return;
          }
        } else {
          const force = req.url.includes('force=1');
          payload = { ok: true, data: await capcycle.runCapcycle({ force }) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/calendar') {
      // календарь отчётов: тяжёлый (quoteSummary на каждый тикер) — грузится
      // клиентом отдельно после основных данных; кэш 6 ч на сервере
      try {
        const cal = await getCalendar();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(cal));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, items: [] }));
      }
      return;
    }

    if (url === '/api/data') {
      try {
        const D = await getData();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(D));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
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
  }).listen(PORT, () => {
    scheduler.start();
    // предохранитель: один необработанный rejection не должен ронять
    // локальный терминал (ошибки в роутах возвращают 500, но защита на случай будущих багов)
    process.on('unhandledRejection', e => console.error('unhandled rejection (сервер жив):', e && e.message));
    console.log(`\n  Терминал:  http://localhost:${PORT}  ·  лаборатория: http://localhost:${PORT}/lab\n  Оболочка открывается мгновенно, данные — с анимацией загрузки.\n  Автообновление раз в 90 сек. Ctrl+C для остановки.\n`);
  });
}

module.exports = { start };
