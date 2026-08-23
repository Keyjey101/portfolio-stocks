// Заголовки новостей: основной источник — Yahoo Finance RSS,
// фолбэк при сбое/пустоте — NewsAPI (ключ NEWSAPI_KEY в .env, не обязателен).
// Парсер регэкспами (без XML-библиотек), CDATA и базовые сущности срезаются.

const { loadEnv } = require('./env');

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const title = it.match(/<title>([\s\S]*?)<\/title>/);
    const link = it.match(/<link>([\s\S]*?)<\/link>/);
    const date = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!title) continue;
    out.push({
      title: decode(title[1]),
      link: link ? decode(link[1]) : null,
      date: date ? Date.parse(decode(date[1])) : null,
    });
  }
  return out.filter(x => x.title);
}

const UA = { 'User-Agent': 'Mozilla/5.0' };

const newsapiKey = () => process.env.NEWSAPI_KEY || loadEnv().NEWSAPI_KEY || '';

async function fetchYahooRss(ticker, { fetchImpl = fetch, limit = 12 } = {}) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}`;
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`RSS ${ticker}: HTTP ${r.status}`);
  const out = parseRss(await r.text()).slice(0, limit);
  if (!out.length) throw new Error(`RSS ${ticker}: пусто`);
  return out;
}

async function fetchNewsApi(ticker, { fetchImpl = fetch, limit = 12 } = {}) {
  const key = newsapiKey();
  if (!key) throw new Error('нет NEWSAPI_KEY');
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker)}&language=en&sortBy=publishedAt&pageSize=${limit}&apiKey=${key}`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`NewsAPI ${ticker}: HTTP ${r.status}`);
  const j = await r.json();
  return (j.articles || [])
    .map(a => ({ title: a.title, link: a.url, date: a.publishedAt ? Date.parse(a.publishedAt) : null }))
    .filter(x => x.title)
    .slice(0, limit);
}

async function fetchHeadlines(ticker, opts = {}) {
  try {
    return await fetchYahooRss(ticker, opts);
  } catch (e) {
    if (!newsapiKey()) throw e; // ключа нет — честно отдаём исходную ошибку Yahoo
    return fetchNewsApi(ticker, opts);
  }
}

module.exports = { parseRss, fetchHeadlines, fetchYahooRss, fetchNewsApi };
