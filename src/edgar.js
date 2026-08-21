// SEC EDGAR: тикер → CIK (company_tickers.json) + свежие филлинги (submissions).
// Кэш: карта тикеров 7 дней, submissions по CIK 6 часов. UA обязателен.

const { readCache, writeCache } = require('./cache');

const DAY = 24 * 3600e3;
const UA = { 'User-Agent': 'portfolio-terminal/1.0 (personal research)' };

// {«0»:{cik_str,ticker,title},…} → {AAPL:'0000320193',…}
function parseTickerMap(j) {
  const out = {};
  if (!j || typeof j !== 'object') return out;
  for (const v of Object.values(j)) {
    if (v && v.ticker && Number.isFinite(v.cik_str)) {
      out[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
    }
  }
  return out;
}

// свежие филлинги нужных форм, URL на первичный документ
function parseFilings(j, { cik, forms = ['8-K', '10-Q', '10-K'], limit = 8 } = {}) {
  const recent = j?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return [];
  const cikNum = String(cik).replace(/^0+/, '');
  const rows = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (!forms.includes(recent.form[i])) continue;
    const acc = String(recent.accessionNumber?.[i] || '').replace(/-/g, '');
    const doc = recent.primaryDocument?.[i];
    if (!acc || !doc) continue;
    rows.push({
      form: recent.form[i],
      date: recent.filingDate?.[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${doc}`,
    });
  }
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, limit);
}

async function getTickerMap({ fetchImpl = fetch } = {}) {
  const cached = readCache('edgar-map', 7 * DAY);
  if (cached) return cached;
  const r = await fetchImpl('https://www.sec.gov/files/company_tickers.json', {
    headers: UA, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`EDGAR map: HTTP ${r.status}`);
  const map = parseTickerMap(await r.json());
  writeCache('edgar-map', map);
  return map;
}

async function edgarRecent(ticker, { fetchImpl = fetch, limit = 8 } = {}) {
  const T = String(ticker).toUpperCase();
  const map = await getTickerMap({ fetchImpl });
  const cik = map[T];
  if (!cik) return [];
  const cacheName = `edgar-sub-${cik}`;
  const cached = readCache(cacheName, 6 * 3600e3);
  if (cached) return cached;
  const r = await fetchImpl(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: UA, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`EDGAR ${T}: HTTP ${r.status}`);
  const rows = parseFilings(await r.json(), { cik, limit });
  writeCache(cacheName, rows);
  return rows;
}

module.exports = { parseTickerMap, parseFilings, getTickerMap, edgarRecent };
