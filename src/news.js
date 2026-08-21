// Заголовки новостей Yahoo Finance: RSS https://feeds.finance.yahoo.com/rss/2.0/headline?s=TICKER
// Парсер регэкспами (без XML-библиотек), CDATA и базовые сущности срезаются.

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

async function fetchHeadlines(ticker, { fetchImpl = fetch, limit = 12 } = {}) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}`;
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`RSS ${ticker}: HTTP ${r.status}`);
  const text = await r.text();
  return parseRss(text).slice(0, limit);
}

module.exports = { parseRss, fetchHeadlines };
