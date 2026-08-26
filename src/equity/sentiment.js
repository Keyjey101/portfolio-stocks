// Market sentiment (спека 02 §2.5, без LLM): short interest из quick-данных,
// опционный сентимент (ближайший экспири, v7/options), календарь отчётов
// и средний EPS-сюрприз из датасета. Всё падает мягко — блок «недоступен».

const UA = { 'User-Agent': 'Mozilla/5.0' };

const asPct = v => (v == null ? null : Math.abs(v) > 1 ? v : v * 100); // доля → %

function shortInterest(quick) {
  if (!quick) return null;
  const pct = quick.short_pct_of_float != null ? asPct(quick.short_pct_of_float) : null;
  const ratio = quick.short_ratio ?? null;
  if (pct == null && ratio == null) return null;
  let signal = 'low_short_interest';
  if (pct != null && pct > 30) signal = 'short_squeeze_potential';
  else if (pct != null && pct > 20) signal = 'high_short_interest';
  else if (pct != null && pct > 10) signal = 'moderate_short_interest';
  return {
    short_pct_of_float: pct != null ? +pct.toFixed(2) : null,
    short_ratio: ratio != null ? +ratio.toFixed(2) : null,
    signal,
  };
}

// v7/finance/options без крамба обычно открыт
async function optionsSentiment(ticker, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`,
      { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    const near = j?.optionChain?.result?.[0];
    const exp = near?.options?.[0];
    if (!exp) return null;
    const sum = arr => (arr || []).reduce((s, o) => s + (Number.isFinite(o.volume) ? o.volume : 0), 0);
    const sumOi = arr => (arr || []).reduce((s, o) => s + (Number.isFinite(o.openInterest) ? o.openInterest : 0), 0);
    const callVol = sum(exp.calls), putVol = sum(exp.puts);
    const callOi = sumOi(exp.calls), putOi = sumOi(exp.puts);
    const pcr = callVol > 0 ? putVol / callVol : null;
    const pcrOi = callOi > 0 ? putOi / callOi : null;
    const ivs = (exp.calls || [])
      .map(o => o.impliedVolatility)
      .filter(v => Number.isFinite(v) && v > 0 && v < 2.0) // кап сэмплов <200%
      .sort((a, b) => a - b);
    const med = arr => (arr.length ? arr[arr.length >> 1] : null);
    let signal = 'neutral';
    if (pcr != null && pcr > 1.2) signal = 'bearish';
    else if (pcr != null && pcr < 0.7) signal = 'bullish';
    return {
      put_call_ratio: pcr != null ? +pcr.toFixed(2) : null,
      put_call_ratio_oi: pcrOi != null ? +pcrOi.toFixed(2) : null,
      implied_volatility: med(ivs) != null ? +(med(ivs) * 100).toFixed(1) : null,
      nearest_expiry: near.expirationDates?.[0]
        ? new Date(near.expirationDates[0] * 1000).toISOString().slice(0, 10) : null,
      signal,
    };
  } catch { return null; }
}

function earningsData(ds, now = Date.now()) {
  const dates = (ds?.earnings_dates || []).map(Number).filter(Boolean).sort((a, b) => a - b);
  const next = dates.find(d => d > now);
  const surprises = ds?.earnings_surprises || [];
  const avg = surprises.length ? surprises.reduce((s, x) => s + x, 0) / surprises.length : null;
  return {
    next_earnings_date: next ? new Date(next).toISOString().slice(0, 10) : null,
    days_until_earnings: next ? Math.round((next - now) / 864e5) : null,
    last_4_surprises: surprises.map(s => +s.toFixed(1)),
    avg_eps_surprise_pct: avg != null ? +avg.toFixed(1) : null,
  };
}

async function marketSentiment(ds, { fetchImpl = fetch } = {}) {
  const si = shortInterest(ds?.quick);
  const os = await optionsSentiment(ds.meta?.ticker, { fetchImpl });
  const ed = earningsData(ds);
  const empty = !si && !os && ed.days_until_earnings == null;
  return {
    short_interest: si,
    options_sentiment: os,
    earnings_data: ed,
    sentiment_interpretation: null, // пишет risk-агент (LLM)
    _empty: empty,
  };
}

module.exports = { marketSentiment, shortInterest, optionsSentiment, earningsData };
