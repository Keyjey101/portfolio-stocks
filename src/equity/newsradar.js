// News radar (спека 02 §2.4): негативные новости по тикеру + LLM-классификация.
// Источники: заголовки Yahoo RSS + NewsAPI /everything с негативным запросом
// (окно 90 дней, ≤12, дедуп по нормализованному заголовку). Отказ LLM ≠ отказ
// анализа: эвристический уровень по числу негативных хитов.

const { loadEnv } = require('../env');
const { newsRadar } = require('./agents');
const log = require('../log');

const UA = { 'User-Agent': 'Mozilla/5.0' };
const NEG_RE = /fraud|lawsuit|class action|investigation|probe|short seller|short report|\bSEC\b|subpoena|recall|downgrade|guidance cut|restat|default|bankrupt|scandal|resign|layoff|delist|misses|plunge|tumble|sink|slide|falls|drop/i;
const WINDOW_MS = 90 * 864e5;

const norm = t => String(t).toLowerCase().replace(/[^\wа-яё]+/gi, ' ').trim();

async function fetchYahooNegative(ticker, { fetchImpl = fetch, limit = 12 } = {}) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}`;
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`RSS ${ticker}: HTTP ${r.status}`);
  const { parseRss } = require('../news');
  return parseRss(await r.text())
    .filter(h => h.date == null || h.date > Date.now() - WINDOW_MS)
    .filter(h => NEG_RE.test(h.title))
    .slice(0, limit)
    .map(h => ({ title: h.title, date: h.date ? new Date(h.date).toISOString().slice(0, 10) : null, link: h.link }));
}

async function fetchNewsApiNegative(companyName, ticker, { fetchImpl = fetch, limit = 12 } = {}) {
  const key = process.env.NEWSAPI_KEY || loadEnv().NEWSAPI_KEY || '';
  if (!key || !companyName) return [];
  const q = `"${companyName}" AND (fraud OR lawsuit OR "class action" OR investigation OR probe OR "short seller" OR "short report" OR SEC OR subpoena OR recall OR downgrade OR "guidance cut" OR restatement OR default OR bankruptcy OR scandal OR resign OR layoffs OR delisting)`;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${limit}&from=${new Date(Date.now() - WINDOW_MS).toISOString().slice(0, 10)}&apiKey=${key}`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.articles || [])
    .filter(a => a.title && !/removed/i.test(a.title))
    .map(a => ({ title: a.title, date: a.publishedAt ? a.publishedAt.slice(0, 10) : null, link: a.url }));
}

function dedup(items) {
  const seen = new Set(), out = [];
  for (const it of items) {
    const k = norm(it.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= 12) break;
  }
  return out;
}

// эвристический fallback-уровень (LLM недоступен, но хиты есть)
function heuristicLevel(n) {
  if (!n) return 'none';
  if (n >= 4) return 'elevated';
  if (n >= 1) return 'watch';
  return 'none';
}

// ── главный вход: негативные новости + LLM-классификация ──
async function fetchNegativeNews(ticker, companyName, { fetchImpl = fetch, llm = null } = {}) {
  const T = String(ticker).toUpperCase();
  let hits = [];
  try { hits = hits.concat(await fetchYahooNegative(T, { fetchImpl })); }
  catch (e) { log.warn(`news RSS ${T}`, e); }
  try { hits = hits.concat(await fetchNewsApiNegative(companyName, T, { fetchImpl })); }
  catch (e) { log.warn(`news NewsAPI ${T} (опционален)`, e); }
  hits = dedup(hits);

  if (!hits.length) {
    return { risk_level: 'none', events: [], summary: null, headlines: [] };
  }

  if (llm) {
    const out = await newsRadar(T, companyName, hits, { llm })
      .catch(e => { log.warn(`news LLM-классификация ${T} (эвристика)`, e); return null; });
    if (out) {
      // гард: elevated/severe без событий → понижаем (спека §2.4)
      if (['elevated', 'severe'].includes(out.risk_level) && !(out.events || []).length) {
        out.risk_level = 'watch';
      }
      return { ...out, headlines: hits };
    }
  }
  // фоллбек без LLM: уровень по числу хитов, события «прочее»
  return {
    risk_level: heuristicLevel(hits.length),
    events: hits.slice(0, 5).map(h => ({ type: 'other', headline: h.title, date: h.date, summary: null })),
    summary: null,
    headlines: hits,
  };
}

module.exports = { fetchNegativeNews, dedup, heuristicLevel, NEG_RE };
