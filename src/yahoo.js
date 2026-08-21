// Yahoo Finance: загрузка котировок и утилиты для рядов

const UA = { 'User-Agent': 'Mozilla/5.0' };

async function chart(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`${symbol}: нет данных`);
  const q = res.indicators.quote[0];
  const closes = (q.close || []).filter(v => v != null);
  return {
    price: res.meta.regularMarketPrice ?? closes.at(-1),
    // вчерашнее закрытие: chartPreviousClose при range=3mo — это закрытие
    // ПЕРЕД диапазоном (3 месяца назад), поэтому берём предпоследнюю точку
    prevClose: closes.length >= 2 ? closes.at(-2) : null,
    closes,
    hi52: res.meta.fiftyTwoWeekHigh,
    lo52: res.meta.fiftyTwoWeekLow,
  };
}

const sma = (a, n) => a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n;

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

module.exports = { chart, sma, spark, pool };
