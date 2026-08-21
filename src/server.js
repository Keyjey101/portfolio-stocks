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
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        if (req.method === 'POST') {
          const body = await readBody(req);
          const rec = body.action === 'check'
            ? await falsify.check(body.t)
            : await falsify.generate(body.t);
          res.end(JSON.stringify({ ok: true, rec }));
        } else {
          res.end(JSON.stringify({ ok: true, items: falsify.getRegistry() }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/lab/committee') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        if (req.method === 'POST') {
          const body = await readBody(req);
          const out = body.action === 'score'
            ? { scored: await committee.scoreMatured() }
            : await committee.runCommittee();
          res.end(JSON.stringify({ ok: true, ...out }));
        } else {
          const brier = committee.brierByRole();
          res.end(JSON.stringify({
            ok: true,
            roles: committee.ROLES,
            brier,
            weights: committee.consensusWeights(),
            calibration: committee.calibration(),
            predictions: require('fs').readFileSync(path.join(__dirname, '..', 'data', 'predictions.jsonl'), 'utf8')
              .split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-60).reverse(),
          }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (url === '/api/journal') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        if (req.method === 'POST') {
          const b = await readBody(req);
          journal.addDecision(b);
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.end(JSON.stringify({ ok: true, decisions: journal.listDecisions() }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
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
    console.log(`\n  Терминал:  http://localhost:${PORT}  ·  лаборатория: http://localhost:${PORT}/lab\n  Оболочка открывается мгновенно, данные — с анимацией загрузки.\n  Автообновление раз в 90 сек. Ctrl+C для остановки.\n`);
  });
}

module.exports = { start };
