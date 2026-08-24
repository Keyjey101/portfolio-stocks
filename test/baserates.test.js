'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSp500, extractEvents, aggregate } = require('../src/lab/baserates');

const WIKI_FIXTURE = `<table class="wikitable sortable mw-collapsible sticky-header" id="constituents"><tbody id="mwIA">
<tr id="mwIQ"><th id="mwIg"><a rel="mw:WikiLink" href="/wiki/Symbol">Symbol</a></th><th>Security</th></tr>
<tr id="mwLQ"><td><a href="/wiki/Apple_Inc." title="Apple Inc.">AAPL</a></td><td>Apple Inc.</td></tr>
<tr id="mwOQ"><td><a rel="nofollow" class="external text" href="x">BRK.B</a></td><td>Berkshire Hathaway</td></tr>
<tr><td><a href="/wiki/Microsoft" title="Microsoft">MSFT</a></td><td>Microsoft</td></tr>
</tbody></table>`;

test('parseSp500: тикеры из таблицы constituents, точки сохраняются', () => {
  const t = parseSp500(WIKI_FIXTURE);
  assert.deepEqual(t, ['AAPL', 'BRK.B', 'MSFT']);
  assert.deepEqual(parseSp500('<html>мусор</html>'), []);
});

test('parseSp500: строки и ячейки с id-атрибутами (разметка MediaWiki 2026) распознаются', () => {
  const real = `<table class="wikitable sortable mw-collapsible sticky-header" id="constituents">
<tr id="mwIQ"><th id="mwIg"><a rel="mw:WikiLink" href="x">Symbol</a></th></tr>
<tr id="mwLQ"><td id="mwLg"><a href="x">NVDA</a></td></tr>
</table>`;
  assert.deepEqual(parseSp500(real), ['NVDA']);
});

// синтетика: рост 100→200, потом обвал к 110 (−45% от максимума), затем восстановление к 160
function synthSeries() {
  const closes = [], ts = [];
  let p = 100;
  const t0 = Date.UTC(2016, 0, 1) / 1000;
  for (let i = 0; i < 500; i++) { p *= 1.0015; closes.push(+p.toFixed(4)); ts.push(t0 + i * 86400); } // 500 дн → ~200
  for (let i = 0; i < 120; i++) { p *= 0.994; closes.push(+p.toFixed(4)); ts.push(t0 + (500 + i) * 86400); } // обвал ~49%
  for (let i = 0; i < 260; i++) { p *= 1.0018; closes.push(+p.toFixed(4)); ts.push(t0 + (620 + i) * 86400); } // восстановление
  // шок-день в конце восстановительной фазы
  closes.push(+(p * 0.84).toFixed(4)); ts.push(t0 + 880 * 86400);
  for (let i = 0; i < 130; i++) { p *= 1.001; closes.push(+p.toFixed(4)); ts.push(t0 + (881 + i) * 86400); }
  return { closes, ts };
}

test('extractEvents: просадка ≥40% от 52-нед максимума ловится один раз', () => {
  const { closes, ts } = synthSeries();
  const ev = extractEvents(closes, ts);
  assert.strictEqual(ev.drawdown40.length, 1, 'событие одно — повторные касания не дублируются');
  const e = ev.drawdown40[0];
  assert.ok(e.depth <= -40, 'глубина: ' + e.depth.toFixed(0) + '%');
  // форварды: 21/63/126/252 дн от даты события
  assert.strictEqual(e.fwd.length, 4);
  assert.ok(e.fwd.every(x => x == null || Number.isFinite(x)));
  assert.ok(e.fwd[3] > 0, 'за год от события восстановление: ' + e.fwd[3]);
});

test('extractEvents: шок-день ≤ −15% ловится, форвард 21 дн > 0 (отскок)', () => {
  const { closes, ts } = synthSeries();
  const ev = extractEvents(closes, ts);
  assert.ok(ev.shock15.length >= 1);
  const shock = ev.shock15.find(e => e.depth <= -15);
  assert.ok(shock.fwd[0] > 0, 'через месяц после шока цена выше: ' + shock.fwd[0]);
});

test('extractEvents: спокойный ряд — без событий', () => {
  const closes = [], ts = [];
  let p = 100;
  for (let i = 0; i < 600; i++) { p *= 1.0005; closes.push(p); ts.push(1700000000 + i * 86400); }
  const ev = extractEvents(closes, ts);
  assert.strictEqual(ev.drawdown40.length, 0);
  assert.strictEqual(ev.shock15.length, 0);
});

test('aggregate: медианы/квартили/доля восстановившихся; пустые классы → n=0', () => {
  const ev = {
    drawdown40: [
      { depth: -45, fwd: [5, 10, 20, 30], recovered12m: true },
      { depth: -50, fwd: [-5, 0, 8, 12], recovered12m: false },
      { depth: -42, fwd: [2, 4, 6, 8], recovered12m: true },
    ],
    shock15: [],
  };
  const agg = aggregate(ev);
  assert.strictEqual(agg.drawdown40.n, 3);
  assert.strictEqual(agg.drawdown40.medianFwd[3], 12, 'медиана 30,12,8 → 12');
  assert.ok(Math.abs(agg.drawdown40.recoveredShare - 2 / 3) < 1e-9);
  assert.ok(agg.drawdown40.q1Fwd[3] <= agg.drawdown40.medianFwd[3]);
  assert.ok(agg.drawdown40.q3Fwd[3] >= agg.drawdown40.medianFwd[3]);
  assert.strictEqual(agg.shock15.n, 0);
});
