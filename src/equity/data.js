// Агент данных (спека 02 §2.2): полный датасет и quick-срез для прескрина.
// Источники: Yahoo quoteSummary (cookie+crumb, см. yahoo.js), расширенные
// годовые ряды fundamentals-timeseries (слияние до ~10 лет), график цены,
// дивидендные события, RSS-контекст новостей. Всё с таймаутами и ретраями;
// HTTP 429 → глобальная пауза 60 с (общий флаг модуля, как в спеке 09 §9.4).

const { yahooAuth, chart } = require('../yahoo');
const { fetchHeadlines } = require('../news');
const { readCache, writeCache } = require('../cache');

const UA = { 'User-Agent': 'Mozilla/5.0' };
const HOUR = 3600e3;
const QUICK_TTL = 12 * HOUR;   // кэш прескрина (улучшение 10 §3)
const RETRIES = 2;             // 2 доп. попытки, пауза 2 с

// глобальная пауза при 429: все вызовы модуля вежливо ждут
let pausedUntil = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, { fetchImpl = fetch, headers = UA, timeoutMs = 15000 } = {}) {
  if (Date.now() < pausedUntil) throw new Error('yahoo: глобальная пауза после 429');
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(2000);
    try {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429) { pausedUntil = Date.now() + 60e3; throw new Error('yahoo: HTTP 429'); }
      if (!r.ok) throw new Error(`yahoo: HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (String(e.message).includes('429')) break; // пауза уже выставлена, ретраи бессмысленны
    }
  }
  throw lastErr || new Error('yahoo: не удалось загрузить');
}

// ── quoteSummary с крамбом ──
async function quoteSummary(ticker, modules, { fetchImpl } = {}) {
  const { cookie, crumb } = await yahooAuth({ fetchImpl });
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`
    + `?modules=${modules.join(',')}&crumb=${encodeURIComponent(crumb)}`;
  const j = await fetchJson(url, {
    fetchImpl,
    headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) },
    timeoutMs: 20000,
  });
  const q = j?.quoteSummary?.result?.[0];
  if (!q) {
    const code = j?.quoteSummary?.error?.code;
    if (code === 'Not Found') throw new Error(`${ticker}: тикер не найден`);
    throw new Error(`${ticker}: quoteSummary пуст`);
  }
  return q;
}

// ── расширенные годовые ряды (до ~10 лет) ──
const TS_TYPES = [
  'annualTotalRevenue', 'annualGrossProfit', 'annualOperatingIncome', 'annualNetIncome',
  'annualEBITDA', 'annualBasicEPS', 'annualDilutedEPS', 'annualTotalDebt',
  'annualStockholdersEquity', 'annualTotalAssets',
  'annualCashCashEquivalentsPlusShortTermInvestments', 'annualFreeCashFlow',
  'annualOperatingCashFlow', 'annualCapitalExpenditure',
];

function parseTimeseries(j) {
  // → { annualTotalRevenue: Map<year, value>, ... }
  const out = {};
  for (const res of j?.timeseries?.result || []) {
    const key = Object.keys(res).find(k => k !== 'meta');
    if (!key) continue;
    const m = new Map();
    for (const pt of res[key] || []) {
      if (pt == null || pt.asOfDate == null || pt.reportedValue == null) continue;
      const year = Number(String(pt.asOfDate).slice(0, 4));
      if (Number.isFinite(year) && Number.isFinite(pt.reportedValue.raw)) m.set(year, pt.reportedValue.raw);
    }
    if (m.size) out[key] = m;
  }
  return out;
}

async function timeseriesAnnuals(ticker, { fetchImpl } = {}) {
  const { cookie, crumb } = await yahooAuth({ fetchImpl });
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}`
    + `?type=${TS_TYPES.join(',')}&period1=0&period2=9999999999&lang=en-US&region=US`
    + `&crumb=${encodeURIComponent(crumb)}`;
  const j = await fetchJson(url, {
    fetchImpl,
    headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) },
    timeoutMs: 20000,
  });
  return parseTimeseries(j);
}

// ── вытаскивание чисел из quoteSummary-записей {raw,fmt} ──
const rv = x => (x && Number.isFinite(x.raw) ? x.raw : null);
function pick(entry, keys) {
  for (const k of keys) { const v = rv(entry[k]); if (v != null) return v; }
  return null;
}
// доля: Yahoo возвращает то долю, то проценты (0.0055 vs 0.55) — гармонизируем
const asRatio = v => (v == null ? null : Math.abs(v) > 1 ? v / 100 : v);

// ── модули quoteSummary ──
const QUICK_MODS = ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'summaryProfile', 'assetProfile'];
const FULL_MODS = [...QUICK_MODS, 'calendarEvents', 'earningsHistory', 'earningsTrend',
  'incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory', 'recommendationTrend'];

function quickFromSummary(ticker, q) {
  const sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {}, fd = q.financialData || {}, sp = q.summaryProfile || {};
  return {
    ticker,
    name: q.price?.longName || q.price?.shortName || null,
    sector: sp.sector || null,
    industry: sp.industry || null,
    country: sp.country || null,
    exchange: q.price?.exchangeName || sp.exchange || null,
    currency: sd.currency || fd.currency || null,
    financial_currency: ks.financialCurrency || null,
    quote_type: q.price?.quoteType || null,
    current_price: rv(fd.currentPrice) ?? rv(sd.previousClose) ?? q.price?.regularMarketPrice ?? null,
    market_cap: rv(sd.marketCap) ?? rv(q.price?.marketCap) ?? null,
    avg_volume: rv(sd.averageVolume) ?? rv(sd.averageDailyVolume10Day) ?? null,
    '52w_high': rv(sd.fiftyTwoWeekHigh),
    '52w_low': rv(sd.fiftyTwoWeekLow),
    beta: rv(ks.beta) ?? rv(sd.beta),
    pe_trailing: rv(sd.trailingPE) ?? rv(ks.trailingPE),
    pe_forward: rv(sd.forwardPE) ?? rv(ks.forwardPE),
    pb: rv(ks.priceToBook),
    ev_ebitda: rv(ks.enterpriseToEbitda),
    ps: rv(fd.revenuePerShare) ? null : null,
    dividend_yield: asRatio(rv(sd.dividendYield)),
    dividend_rate: rv(sd.dividendRate),
    payout_ratio: asRatio(rv(sd.payoutRatio)),
    revenue_growth: asRatio(rv(fd.revenueGrowth)),
    profit_margin: asRatio(rv(fd.profitMargins)),
    operating_margin: asRatio(rv(fd.operatingMargins)),
    gross_margin: asRatio(rv(fd.grossMargins)),
    roe: asRatio(rv(fd.returnOnEquity)),
    roa: asRatio(rv(fd.returnOnAssets)),
    ebitda_cur: rv(fd.ebitda),
    total_debt: rv(fd.totalDebt),
    total_cash: rv(fd.totalCash),
    free_cashflow: rv(fd.freeCashflow),
    operating_cf: rv(fd.operatingCashflow),
    trailing_eps: rv(ks.trailingEps) ?? rv(sd.trailingEps),
    forward_eps: rv(ks.forwardEps) ?? rv(sd.forwardEps),
    shares_outstanding: rv(ks.sharesOutstanding),
    float_shares: rv(ks.floatShares),
    shares_short: rv(ks.sharesShort),
    short_pct_of_float: asRatio(rv(ks.shortPercentOfFloat)),
    short_ratio: rv(ks.shortRatio),
    target_mean: rv(fd.targetMeanPrice),
    target_high: rv(fd.targetHighPrice),
    target_low: rv(fd.targetLowPrice),
    recommendation: fd.recommendationKey || null,
    n_analysts: rv(fd.numberOfAnalystOpinions),
    description: String(q.assetProfile?.longBusinessSummary || '').slice(0, 400) || null,
  };
}

// ── quick-срез для прескрина (кэш 12 ч) ──
async function fetchQuick(ticker, { fetchImpl = fetch, force = false } = {}) {
  const T = String(ticker).toUpperCase();
  const key = `eq-quick-${T.replace(/[^A-Z0-9.-]/g, '_')}`;
  if (!force) {
    const c = readCache(key, QUICK_TTL);
    if (c) return c;
  }
  let q;
  try {
    q = await quoteSummary(T, QUICK_MODS, { fetchImpl });
  } catch (e) {
    // тикер мёртв — тоже кэшируем (отрицательный результат, спека 09 §9.2)
    if (/не найден|пуст/.test(e.message)) { writeCache(key, null); return null; }
    throw e;
  }
  const out = quickFromSummary(T, q);
  //Ps в quick не считаем: выручки здесь нет — прескрин живёт тем, что есть
  writeCache(key, out);
  return out;
}

// ── годовые ряды из statement history (4 года, свежие первыми) ──
function statementsFromSummary(q) {
  const income = [], balance = [], cash = [];
  for (const e of q.incomeStatementHistory?.incomeStatementHistory || []) {
    income.push({
      year: Number(String(e.end?.fmt || '').slice(0, 4)) || null,
      end: e.end?.fmt || null,
      revenue: pick(e, ['totalRevenue']),
      gross_profit: pick(e, ['grossProfit']),
      operating_income: pick(e, ['operatingIncome']),
      net_income: pick(e, ['netIncome']),
      ebitda: pick(e, ['ebitda']),
      interest_expense: pick(e, ['interestExpense']),
      eps: pick(e, ['dilutedEPS', 'basicEPS']),
    });
  }
  for (const e of q.balanceSheetHistory?.balanceSheetHistory || []) {
    balance.push({
      year: Number(String(e.end?.fmt || '').slice(0, 4)) || null,
      end: e.end?.fmt || null,
      total_assets: pick(e, ['totalAssets']),
      total_equity: pick(e, ['totalStockholderEquity']),
      total_debt: pick(e, ['totalDebt', 'longTermDebt']),
      cash: pick(e, ['cashCashEquivalents', 'cash', 'totalCash']),
    });
  }
  for (const e of q.cashflowStatementHistory?.cashflowStatementHistory || []) {
    cash.push({
      year: Number(String(e.end?.fmt || '').slice(0, 4)) || null,
      end: e.end?.fmt || null,
      operating_cf: pick(e, ['totalCashFromOperatingActivities']),
      capex: pick(e, ['capitalExpenditure']),
      dividends_paid: pick(e, ['dividendsPaid']),
    });
  }
  return { income, balance, cash };
}

// слияние statement history + timeseries до ~10 лет; statement history приоритетнее
function mergeAnnuals(stmts, ts) {
  const byYear = kind => {
    const m = new Map();
    for (const r of stmts[kind]) if (r.year && !m.has(r.year)) m.set(r.year, { ...r });
    return m;
  };
  const TS_OF = {
    income: {
      revenue: 'annualTotalRevenue', gross_profit: 'annualGrossProfit',
      operating_income: 'annualOperatingIncome', net_income: 'annualNetIncome',
      ebitda: 'annualEBITDA', eps: 'annualDilutedEPS',
    },
    balance: {
      total_assets: 'annualTotalAssets', total_equity: 'annualStockholdersEquity',
      total_debt: 'annualTotalDebt', cash: 'annualCashCashEquivalentsPlusShortTermInvestments',
    },
    cash: {
      operating_cf: 'annualOperatingCashFlow',
      capex: 'annualCapitalExpenditure',
    },
  };
  for (const kind of Object.keys(TS_OF)) {
    const m = byYear(kind);
    for (const [field, tsKey] of Object.entries(TS_OF[kind])) {
      const series = ts[tsKey];
      if (!series) continue;
      for (const [year, val] of series) {
        let row = m.get(year);
        if (!row) { row = { year, end: `${year}-12-31` }; m.set(year, row); }
        if (row[field] == null) row[field] = val;
      }
    }
    stmts[kind] = [...m.values()].sort((a, b) => b.year - a.year);
  }
  return stmts;
}

// производные по годам (спека 02 §2.2); все ряды — свежие первыми
function deriveSeries(annual, meta) {
  const years = [...new Set([...annual.income, ...annual.balance, ...annual.cash].map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  const inc = new Map(annual.income.map(r => [r.year, r]));
  const bal = new Map(annual.balance.map(r => [r.year, r]));
  const cf = new Map(annual.cash.map(r => [r.year, r]));
  const d = { year: [] };
  for (const y of years) {
    const idx = d.year.length; // индекс ДО пуша года — без дырок на [0]
    d.year.push(y);
    const push = (k, v) => { (d[k] = d[k] || [])[idx] = v; };
    const i = inc.get(y) || {}, b = bal.get(y) || {}, c = cf.get(y) || {};
    const rev = i.revenue, gp = i.gross_profit, oi = i.operating_income, ni = i.net_income;
    const ebitda = i.ebitda ?? oi;
    const ocf = c.operating_cf ?? null, capex = c.capex ?? null;
    const fcf = ocf != null ? ocf + (capex || 0) : null;
    const debt = b.total_debt, eq = b.total_equity, cash = b.cash;
    const ic = (debt != null || eq != null) ? Math.max(1e-9, (debt || 0) + (eq || 0) - (cash || 0)) : null;
    d.year.push(y);
    push('revenue', rev); push('gross_profit', gp); push('operating_income', oi);
    push('net_income', ni); push('ebitda', ebitda); push('interest_expense', i.interest_expense);
    push('total_assets', b.total_assets); push('total_equity', eq); push('total_debt', debt);
    push('cash', cash); push('operating_cf', ocf); push('capex', capex); push('dividends_paid', c.dividends_paid);
    push('free_cash_flow', fcf); push('eps', i.eps);
    push('gross_margin', rev > 0 && gp != null ? gp / rev : null);
    push('operating_margin', rev > 0 && oi != null ? oi / rev : null);
    push('net_margin', rev > 0 && ni != null ? ni / rev : null);
    push('fcf_margin', rev > 0 && fcf != null ? fcf / rev : null);
    push('roic', ic && ni != null && ic > 0 ? ni / ic : null);
    push('roe', eq != null && ni != null && eq > 0 ? ni / eq : null);
    push('net_debt', debt != null && cash != null ? debt - cash : null);
    push('debt_ebitda', debt != null && ebitda > 0 ? debt / ebitda : null);
    push('interest_coverage', oi != null && i.interest_expense ? oi / Math.abs(i.interest_expense) : null);
    push('fcf_conversion', fcf != null && ni > 0 ? fcf / ni : null);
  }
  return d;
}

// ── дивиденды за 10 лет (chart events=div) ──
async function dividendHistory(ticker, { fetchImpl } = {}) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=10y&events=div`;
    const j = await fetchJson(url, { fetchImpl });
    const evs = j?.chart?.result?.[0]?.events?.dividends || {};
    const byYear = new Map();
    for (const ev of Object.values(evs)) {
      const y = new Date(ev.date * 1000).getUTCFullYear();
      byYear.set(y, (byYear.get(y) || 0) + ev.amount);
    }
    return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, dps]) => ({ year, dps }));
  } catch { return []; }
}

// ── FX-нормализация (ADR/иностр. валюта, спека 02 §2.2) ──
async function fxRate(from, to, { fetchImpl } = {}) {
  if (!from || !to || from === to) return 1;
  try {
    const c = await chart(`${from}${to}=X`, '5d', { fetchImpl });
    const last = c.closes && c.closes.length ? c.closes.at(-1) : null;
    return Number.isFinite(last) && last > 0 ? last : 1;
  } catch { return 1; }
}

const MONEY_KEYS = new Set(['revenue', 'gross_profit', 'operating_income', 'net_income', 'ebitda',
  'interest_expense', 'total_assets', 'total_equity', 'total_debt', 'cash', 'operating_cf', 'capex',
  'dividends_paid', 'free_cash_flow']);

// ── полный датасет (спека 02 §2.2) ──
async function fetchFull(ticker, { fetchImpl = fetch, withNews = true } = {}) {
  const T = String(ticker).toUpperCase();
  const q = await quoteSummary(T, FULL_MODS, { fetchImpl });
  const quick = quickFromSummary(T, q);

  let annual = statementsFromSummary(q);
  try { annual = mergeAnnuals(annual, await timeseriesAnnuals(T, { fetchImpl })); } catch { /* расширенные ряды опциональны */ }

  // FX-нормализация: отчётность в иной валюте, чем котировка
  let fx = 1, currency_normalized = false;
  if (quick.financial_currency && quick.currency && quick.financial_currency !== quick.currency) {
    fx = await fxRate(quick.financial_currency, quick.currency, { fetchImpl });
    currency_normalized = fx !== 1;
  }
  if (fx !== 1) {
    for (const kind of ['income', 'balance', 'cash']) {
      for (const row of annual[kind]) for (const k of Object.keys(row)) if (MONEY_KEYS.has(k) && row[k] != null) row[k] *= fx;
    }
  }

  const derived = deriveSeries(annual, quick);

  // график: 90-дневная доходность и просадка от 52w high
  let price_hist = { closes_1y: [], ret_90d: null, drawdown_52w: null };
  try {
    const ch = await chart(T, '1y', { fetchImpl });
    const closes = ch.closes || [];
    const last = closes.at(-1);
    const p90 = closes.length > 63 ? closes[closes.length - 64] : closes[0];
    price_hist = {
      closes_1y: closes,
      ret_90d: last && p90 ? last / p90 - 1 : null,
      drawdown_52w: last && ch.hi52 ? last / ch.hi52 - 1 : null,
    };
  } catch { /* график опционален */ }

  // дивиденды
  const divHist = await dividendHistory(T, { fetchImpl });
  const yield0 = quick.dividend_yield;
  const annualDps = divHist[0] ? divHist[0].dps : (quick.dividend_rate != null ? quick.dividend_rate : null);
  const avg5 = divHist.slice(0, 5).map(x => x.dps);
  const fiveYrAvgYield = avg5.length && quick.current_price
    ? avg5.reduce((s, x) => s + x, 0) / avg5.length / quick.current_price
    : null;
  const exDate = q.calendarEvents?.exDividendDate?.fmt || null;
  const dividend_data = {
    yield: yield0,
    annual_dps: annualDps,
    ex_date: exDate,
    payout_ratio: quick.payout_ratio,
    five_yr_avg_yield: fiveYrAvgYield,
    history_annual: divHist.slice(0, 10),
  };

  // EPS-тренды (5 лет: год, выручка, прибыль)
  const eps_data = {
    trailing_eps: quick.trailing_eps,
    forward_eps: quick.forward_eps,
    annual_earnings: derived.year.slice(0, 5).map((y, idx) => ({
      year: y,
      revenue: derived.revenue?.[idx] ?? null,
      earnings: derived.net_income?.[idx] ?? null,
    })),
  };

  // аналитики: earningsTrend даёт рост EPS на +1y/+5y
  const trend = q.earningsTrend?.trend || [];
  const trOf = period => {
    const t = trend.find(x => x.period === period);
    return t && Number.isFinite(t.growth?.raw) ? t.growth.raw : null;
  };
  const analyst = {
    target_mean: quick.target_mean,
    target_high: quick.target_high,
    target_low: quick.target_low,
    recommendation: quick.recommendation,
    n_analysts: quick.n_analysts,
    eps_growth_next_year: trOf('+1y'),
    eps_growth_next_5y: trOf('+5y'),
    revenue_growth: quick.revenue_growth,
  };

  // сентимент-сырьё (без LLM, спека 02 §2.5)
  const eh = (q.earningsHistory?.history || []).slice(0, 4)
    .map(h => (Number.isFinite(h.surprisePercent?.raw) ? h.surprisePercent.raw : null))
    .filter(v => v != null);

  // sanity-флаги
  const sanity = [];
  const gp0 = derived.gross_profit?.[0], oi0 = derived.operating_income?.[0];
  if (gp0 != null && oi0 != null && gp0 > 0 && oi0 > 1.02 * gp0) sanity.push('gross_profit_implausible');
  if (derived.total_equity?.[0] != null && derived.total_equity[0] <= 0) sanity.push('negative_book_equity');
  const rev0 = derived.revenue?.[0], rev1 = derived.revenue?.[1];
  if (rev0 != null && rev1 != null && rev1 > 0 && quick.market_cap > 2e9 && Math.abs(rev0 / rev1 - 1) > 1) sanity.push('revenue_discontinuity');
  if (currency_normalized) sanity.push('currency_normalized');

  // мультипликаторы (пересчёт от нормализованных значений при FX)
  const shares = quick.shares_outstanding || (quick.market_cap && quick.current_price ? quick.market_cap / quick.current_price : null);
  const ev = quick.market_cap != null && derived.net_debt?.[0] != null
    ? quick.market_cap + derived.net_debt[0]
    : (rv(q.defaultKeyStatistics?.enterpriseValue) ?? null);
  const ebitda0 = derived.ebitda?.[0];
  const equity0 = derived.total_equity?.[0];
  const multiples = {
    pe_trailing: quick.pe_trailing,
    pe_forward: quick.pe_forward,
    pb: quick.pb ?? (equity0 > 0 && shares ? (quick.current_price * shares) / equity0 : null),
    ps: quick.market_cap != null && derived.revenue?.[0] > 0 ? quick.market_cap / derived.revenue[0] : null,
    peg: quick.pe_forward != null && analyst.eps_growth_next_5y > 0 ? quick.pe_forward / (analyst.eps_growth_next_5y * 100) : null,
    ev_ebitda: ev != null && ebitda0 > 0 ? ev / ebitda0 : quick.ev_ebitda,
    ev_revenue: ev != null && derived.revenue?.[0] > 0 ? ev / derived.revenue[0] : null,
    fcf_yield: derived.free_cash_flow?.[0] != null && quick.market_cap > 0 ? derived.free_cash_flow[0] / quick.market_cap : null,
  };

  // контекст новостей для промптов (≤10, ≤300 символов)
  let news_context = [];
  if (withNews) {
    try {
      const hs = await fetchHeadlines(T, { fetchImpl, limit: 10 });
      news_context = hs.map(h => ({ title: String(h.title).slice(0, 300), date: h.date }));
    } catch { /* без новостей анализ жив */ }
  }

  return {
    ticker: T,
    fetched_at: Date.now(),
    meta: {
      ticker: T, name: quick.name, sector: quick.sector, industry: quick.industry,
      country: quick.country, currency: quick.currency, exchange: quick.exchange,
      current_price: quick.current_price, market_cap: quick.market_cap,
      enterprise_value: ev, shares_outstanding: shares, float_shares: quick.float_shares,
      beta: quick.beta, '52w_high': quick['52w_high'], '52w_low': quick['52w_low'],
      avg_volume: quick.avg_volume, description: quick.description,
      financial_currency: quick.financial_currency,
    },
    quick,
    multiples,
    annual,
    derived,
    dividend_data,
    eps_data,
    analyst,
    earnings_surprises: eh,
    earnings_dates: (q.calendarEvents?.earnings?.earningsDate || [])
      .map(d => (d && Number.isFinite(d.raw) ? d.raw * 1000 : null)).filter(Boolean),
    data_sanity_flags: sanity,
    currency_normalized,
    price_hist,
    news_context,
  };
}

module.exports = {
  fetchQuick, fetchFull, quickFromSummary, statementsFromSummary,
  mergeAnnuals, deriveSeries, asRatio, pick, parseTimeseries,
};
