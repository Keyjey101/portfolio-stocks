// #7 движок базовых ставок: эмпирика S&P 500 (10 лет Yahoo) по классам событий
// + LLM-приор с явной пометкой. Вселенная — сегодняшние живые участники
// (survivorship bias подписан в UI).
const fs = require('fs');
const path = require('path');
const { chart, pool } = require('../yahoo');
const { readCache, writeCache } = require('../cache');
const { quantile } = require('../math/stats');
const defaultLlm = require('../llm');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'baserates');
const EVENTS_FILE = path.join(DIR, 'events.json');
const WIKI_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

// ── вселенная ──
function parseSp500(html) {
  if (!html || typeof html !== 'string') return [];
  const m = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i);
  if (!m) return [];
  const rows = m[0].match(/<tr>[^]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const td = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i);
    if (!td) continue;
    const sym = td[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (/^[A-Z][A-Z0-9.-]{0,6}$/.test(sym) && sym !== 'Symbol') out.push(sym);
  }
  return out;
}

async function fetchUniverse({ fetchImpl = fetch, limit } = {}) {
  const cached = readCache('sp500-universe', 89 * 864e5);
  let symbols = cached;
  if (!symbols) {
    const r = await fetchImpl(WIKI_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('wikipedia: HTTP ' + r.status);
    symbols = parseSp500(await r.text());
    if (symbols.length < 100) throw new Error('wikipedia: распознано ' + symbols.length + ' тикеров');
    writeCache('sp500-universe', symbols);
  }
  return (limit && limit < symbols.length) ? symbols.slice(0, limit) : symbols;
}

// ── события из ряда ──
// drawdown40: цена ≤ 60% от скользящего 52-нед максимума (первое касание за эпизод;
// эпизоды разделены восстановлением выше 75% максимума)
// shock15: дневная доходность ≤ −15%
// fwd — форвардные доходности % на 21/63/126/252 торговых дня (null за краем ряда)
const FWD_DAYS = [21, 63, 126, 252];

function extractEvents(closes, ts) {
  const out = { drawdown40: [], shock15: [] };
  const n = closes.length;
  if (n < 260) return out;

  // скользящий 252-дн максимум (только прошлые данные)
  const hi = new Array(n).fill(null);
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i >= 252) mx = Math.max(...closes.slice(i - 252, i));
    hi[i] = mx === -Infinity ? null : mx;
  }

  let inEpisode = false;
  for (let i = 252; i < n; i++) {
    const h = hi[i];
    if (h == null) continue;
    const dd = (closes[i] / h - 1) * 100;
    if (!inEpisode && dd <= -40) {
      inEpisode = true;
      const fwd = FWD_DAYS.map(d => (i + d < n ? (closes[i + d] / closes[i] - 1) * 100 : null));
      out.drawdown40.push({
        date: ts[i], depth: +dd.toFixed(1), fwd,
        recovered12m: fwd[3] != null ? fwd[3] > 0 : null,
      });
    } else if (inEpisode && dd > -25) {
      inEpisode = false; // восстановились — следующий эпизод будет новым событием
    }
  }

  for (let i = 1; i < n; i++) {
    const ret = (closes[i] / closes[i - 1] - 1) * 100;
    if (ret <= -15) {
      const fwd = FWD_DAYS.map(d => (i + d < n ? (closes[i + d] / closes[i] - 1) * 100 : null));
      out.shock15.push({ date: ts[i], depth: +ret.toFixed(1), fwd, recovered12m: fwd[3] != null ? fwd[3] > 0 : null });
    }
  }
  return out;
}

function aggregate(events) {
  const agg = {};
  for (const cls of Object.keys(events)) {
    const rows = events[cls];
    const res = { n: rows.length, medianFwd: [null, null, null, null], q1Fwd: [null, null, null, null], q3Fwd: [null, null, null, null], recoveredShare: null };
    if (rows.length) {
      for (let k = 0; k < 4; k++) {
        const vals = rows.map(r => r.fwd[k]).filter(v => v != null).sort((a, b) => a - b);
        if (vals.length) {
          res.medianFwd[k] = quantile(vals, 0.5);
          res.q1Fwd[k] = quantile(vals, 0.25);
          res.q3Fwd[k] = quantile(vals, 0.75);
        }
      }
      const rec = rows.map(r => r.recovered12m).filter(v => v != null);
      if (rec.length) res.recoveredShare = rec.filter(Boolean).length / rec.length;
    }
    agg[cls] = res;
  }
  return agg;
}

// ── одноразовый бэкфилл (тяжёлый: 10y на всю вселенную) ──
async function backfill({ limit, fetchImpl = fetch } = {}) {
  const symbols = await fetchUniverse({ fetchImpl, limit });
  const events = { drawdown40: [], shock15: [] };
  let okCount = 0;
  await pool(symbols, async t => {
    const d = await chart(t, '10y').catch(() => null);
    if (!d || d.closes.length < 260) return;
    okCount++;
    const ev = extractEvents(d.closes, d.ts);
    ev.drawdown40.forEach(e => events.drawdown40.push({ t, ...e }));
    ev.shock15.forEach(e => events.shock15.push({ t, ...e }));
  }, 4);
  const agg = aggregate(events);
  const res = {
    generatedAt: new Date().toISOString(),
    universe: symbols.length, loaded: okCount,
    counts: { drawdown40: events.drawdown40.length, shock15: events.shock15.length },
    agg,
  };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(EVENTS_FILE, JSON.stringify({ ...res, events }, null, 2));
  return res;
}

const getAggregates = () => readCache('baserates-agg', null) ||
  (fs.existsSync(EVENTS_FILE) ? (() => { const j = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); const { events, ...rest } = j; return rest; })() : null);

// ── запрос: текст → LLM-класс → эмпирика + LLM-приор (помечен) ──
const QUERY_SCHEMA = {
  class: 'enum:drawdown40,shock15,guidance_cut,ceo_exit,dilution,insider_cluster,none',
  prior_note: 'string',
  prior_median_12m: 'number',
};

async function query(text, { llm = defaultLlm } = {}) {
  const agg = getAggregates();
  const classes = agg
    ? Object.entries(agg.counts).map(([k, v]) => `${k} (эмпирика: ${v} событий)`).join(', ')
    : 'нет';
  const v = await llm.chat(
    [{ role: 'system', content: 'Ты аналитик базовых ставок. Отвечай только JSON.' },
     { role: 'user', content: [
       'Событие инвестора: «' + text + '».',
       'Классифицируй его. Эмпирические классы: ' + classes + '.',
       'Если не подходит ничего — class=none.',
       'prior_note — как обычно складывается исход таких событий по экономической логике (1 фраза);',
       'prior_median_12m — твоя оценка медианной 12-мес доходности после события, % (это МНЕНИЕ МОДЕЛИ, будет помечено).',
       'Верни ТОЛЬКО JSON: {"class":"…","prior_note":"…","prior_median_12m":0.0}',
     ].join('\n') }],
    { schema: QUERY_SCHEMA, task: 'baserates-query', temperature: 0.2 },
  );
  const emp = agg && agg.agg[v.class] && agg.agg[v.class].n > 0 ? agg.agg[v.class] : null;
  return {
    query: text,
    classification: v.class,
    empirical: emp ? { ...emp, source: 'S&P 500, 10 лет, survivorship-biased' } : null,
    llmPrior: { note: v.prior_note, median12m: v.prior_median_12m, source: 'мнение модели, не данные' },
  };
}

module.exports = { parseSp500, fetchUniverse, extractEvents, aggregate, backfill, getAggregates, query };
