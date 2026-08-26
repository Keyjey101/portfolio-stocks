'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// тезисы — в отдельный файл, чтобы сидинг не трогал боевой data/theses.json
process.env.THESES_FILE = path.join(__dirname, '..', 'data', 'cache', '.theses-detector-test.json');

const { runDetector } = require('../src/lab/detector');

const RECS = path.join(__dirname, '..', 'data', 'recs.jsonl');
const ATTR_DIR = path.join(__dirname, '..', 'data', 'cache', 'attribution');

function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
}
const seedOf = sym => [...sym].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;

function chartJsonFor(sym, broken = false) {
  const rnd = lcg(seedOf(sym));
  const T = 260;
  const rets = [];
  for (let i = 0; i < T; i++) rets.push(rnd() * 0.012);
  if (broken) for (let i = 0; i < 5; i++) rets[T - 5 + i] += -0.06 - i * 0.004;
  const closes = [], ts = [];
  let p = 100;
  const t0 = Date.UTC(2024, 7, 1) / 1000;
  for (let i = 0; i <= T; i++) {
    closes.push(+p.toFixed(4));
    ts.push(t0 + i * 86400);
    if (i < T) p *= Math.exp(rets[i]);
  }
  return { chart: { result: [{
    meta: { regularMarketPrice: closes.at(-1) },
    timestamp: ts,
    indicators: { quote: [{ close: closes }] },
  }] } };
}

test('runDetector: флаг → LLM-атрибуция → кэш + recs; повтор без force не зовёт LLM', async (t) => {
  const realFetch = globalThis.fetch;
  let llmCalls = 0;
  const llm = { chat: async () => {
    llmCalls++;
    return { verdict: 'thesis_damage', reason: 'гайденс срезан дважды', pillar: 'рост выручки', confidence: 0.85, proposed_state: 'damaged' };
  } };
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async url => {
    const s = String(url);
    if (s.includes('feeds.finance.yahoo.com')) {
      return { ok: true, text: async () => '<rss><channel><item><title>Guidance cut</title><link>l</link></item></channel></rss>' };
    }
    if (s.includes('sec.gov')) {
      return { ok: true, json: async () => ({}), text: async () => '{}' };
    }
  const m = s.match(/\/chart\/([^?]+)/);
  const sym = decodeURIComponent(m[1]);
  return { ok: true, json: async () => chartJsonFor(sym, sym === 'BRKN') };
  };

  const positionsLoader = async () => [
    { t: 'BRKN', qty: 10, avg: 10, tag: 'quality', note: 'тест', lv: null },
    { t: 'OKAY', qty: 10, avg: 10, tag: 'core', note: '', lv: null },
  ];
  const recsBefore = fs.existsSync(RECS) ? fs.readFileSync(RECS, 'utf8').split('\n').filter(Boolean).length : 0;
  const res = await runDetector({ force: true, positionsLoader, factors: ['SPY'], market: 'SPY', llm });
  assert.strictEqual(res.cached, false);
  assert.strictEqual(res.verdicts.length, 1, 'атрибуция только для BRKN');
  assert.strictEqual(res.verdicts[0].t, 'BRKN');
  assert.strictEqual(res.verdicts[0].verdict, 'thesis_damage');
  // у тестового тикера нет записи тезиса — машина состояний честно отказала,
  // не тратя второй LLM-вызов на перевывод
  assert.ok(res.verdicts[0].thesis && res.verdicts[0].thesis.error, 'нет записи — понятная ошибка');
  assert.strictEqual(llmCalls, 1);
  const recsAfter = fs.readFileSync(RECS, 'utf8').split('\n').filter(Boolean).length;
  assert.strictEqual(recsAfter, recsBefore + 1, 'recs.jsonl пополнился');
  assert.ok(fs.existsSync(path.join(ATTR_DIR, 'BRKN.json')), 'вердикт в кэше');

  // повтор без force — cooldown: LLM не зовётся, данные из кэша атрибуции
  const res2 = await runDetector({ positionsLoader, factors: ['SPY'], market: 'SPY', llm });
  assert.strictEqual(llmCalls, 1, 'LLM не должен зваться повторно');
  assert.strictEqual(res2.verdicts.length, 1);
  assert.strictEqual(res2.verdicts[0].verdict, 'thesis_damage');

  // чистка тестовых артефактов (в т.ч. отравленный кэш edgar-map)
  try {
    fs.unlinkSync(path.join(ATTR_DIR, 'BRKN.json'));
    fs.unlinkSync(path.join(__dirname, '..', 'data', 'cache', 'edgar-map.json'));
    fs.unlinkSync(path.join(__dirname, '..', 'data', 'cache', 'detector.json'));
    const lines = fs.readFileSync(RECS, 'utf8').split('\n').filter(l => l && !l.includes('"t":"BRKN"'));
    fs.writeFileSync(RECS, lines.length ? lines.join('\n') + '\n' : '');
  } catch {}
});
