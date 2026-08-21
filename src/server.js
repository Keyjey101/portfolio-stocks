// HTTP-роутер: '/' → public/index.html, '/api/data' → JSON,
// статика public/ (style.css, app.js). Зависимостей нет.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { getData, getCalendar } = require('./signals');
const { runFactors } = require('./lab/factors');
const { runLevels } = require('./lab/levels');
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
