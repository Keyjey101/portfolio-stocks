// Yahoo Finance: загрузка котировок и утилиты для рядов

const UA = { 'User-Agent': 'Mozilla/5.0' };

// Таймаут на каждый запрос: при мёртвой сети (VPN «чёрная дыра») fetch без
// signal висит до дефолтных 5 минут undici — сборка данных растягивается
// на десятки минут, и /api/data не отвечает. 8 секунд — как прямой
// таймаут Tradernet.
const FETCH_MS = 8000;
const fetchT = (url, opts = {}) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || FETCH_MS) });

async function chart(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetchT(url, { headers: UA });
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`${symbol}: нет данных`);
  const q = res.indicators.quote[0];
  const raw = q.close || [];
  const stamps = res.timestamp || [];
  const closes = [], ts = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] == null) continue;
    closes.push(raw[i]);
    ts.push(stamps[i] ?? null);
  }
  return {
    price: res.meta.regularMarketPrice ?? closes.at(-1),
    // вчерашнее закрытие: chartPreviousClose при range=3mo — это закрытие
    // ПЕРЕД диапазоном (3 месяца назад), поэтому берём предпоследнюю точку
    prevClose: closes.length >= 2 ? closes.at(-2) : null,
    closes, ts,
    hi52: res.meta.fiftyTwoWeekHigh,
    lo52: res.meta.fiftyTwoWeekLow,
  };
}

const sma = (a, n) => a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n;

// ── Календарь отчётов: quoteSummary требует cookie + crumb ──
// чистый партер: json → { ts, days } | null (только вперёд, до 30 дней)
function parseEarnings(j, now = Date.now()) {
  const arr = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
  if (!Array.isArray(arr)) return null;
  const soon = arr
    .map(d => (d && typeof d.raw === 'number' ? d.raw * 1000 : null))
    .filter(ts => ts != null && ts > now && ts < now + 31 * 864e5);
  if (!soon.length) return null;
  const ts = Math.min(...soon);
  return { ts, days: Math.max(0, Math.round((ts - now) / 864e5)) };
}

// несколько Set-Cookie в одном заголовке режем по запятой перед «ключ=»
function splitSetCookie(h) {
  if (!h) return [];
  return h.split(/,(?=[^;,]+=[^;,]+)/).map(s => s.trim()).filter(Boolean);
}

let authState = null; // { cookie, crumb, ts } — живёт час
async function yahooAuth() {
  if (authState && Date.now() - authState.ts < 3600e3) return authState;
  // fc.yahoo.com отвечает 404, но выставляет cookie A3
  const r1 = await fetchT('https://fc.yahoo.com/', { headers: UA });
  let cookies = [];
  if (typeof r1.headers.getSetCookie === 'function') cookies = r1.headers.getSetCookie();
  else cookies = splitSetCookie(r1.headers.get('set-cookie'));
  const cookie = cookies.map(c => c.split(';')[0]).join('; ');
  const r2 = await fetchT('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!r2.ok) throw new Error('getcrumb: HTTP ' + r2.status);
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('getcrumb: некорректный ответ');
  authState = { cookie, crumb, ts: Date.now() };
  return authState;
}

const earnCache = new Map(); // symbol → { fetched, res }
const EARN_TTL = 24 * 3600e3;

// дата ближайшего отчёта или null; кэш на сутки
async function earningsDate(symbol) {
  const c = earnCache.get(symbol);
  if (c && Date.now() - c.fetched < EARN_TTL) return c.res;
  const { cookie, crumb } = await yahooAuth();
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetchT(url, { headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) } });
  if (!r.ok) throw new Error(`${symbol}: quoteSummary HTTP ${r.status}`);
  const res = parseEarnings(await r.json());
  earnCache.set(symbol, { fetched: Date.now(), res });
  return res;
}

// прореживание ряда для спарклайнов
function spark(a, max = 48) {
  if (!a || a.length <= 2) return [];
  const src = a.length > max ? null : a;
  if (src) return src.map(v => +(+v).toFixed(2));
  const k = a.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(a[Math.floor(i * k)]);
  out[out.length - 1] = a[a.length - 1];
  return out.map(v => +(+v).toFixed(2));
}

// пул с ограничением параллельности — не душим Yahoo
async function pool(items, fn, size = 6) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

module.exports = { chart, sma, spark, pool, parseEarnings, earningsDate };
