// Оркестратор анализа тикера (спека 02 §2.1): последовательность шагов,
// SSE-кадры прогресса, кросс-вызовы агентов, канонический пересчёт MoS,
// запись вердикта в outcomes. Лок на тикер (TTL 420 c) — параллельные запуски
// того же тикера подписываются на уже идущий прогон. Кэш результата 1 ч;
// при agents_failed ≥ 2 — не кэшируется. Обрыв клиента не роняет анализ:
// прогон живёт отдельным промисом, подписчики лишь читают кадры.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { readCache, writeCache } = require('../cache');
const dataAgent = require('./data');
const { computeMetrics } = require('./financial');
const intrinsic = require('./intrinsic');
const decision = require('./decision');
const { fetchSecData } = require('./secfiling');
const { fetchNegativeNews } = require('./newsradar');
const { marketSentiment } = require('./sentiment');
const agents = require('./agents');
const { PEERS_MAP, universe, SECTOR_OF_BASKET } = require('./universe');

const HOUR = 3600e3;

// ── кэш-ключи (спека 08 §8.1) ──
const sortedJson = o => JSON.stringify(o, Object.keys(o).sort());
const analysisKey = (type, params) => crypto.createHash('sha256').update(`${type}:${sortedJson(params)}`).digest('hex').slice(0, 24);

// ── реестр активных прогонов: «тикер:тип» → run ──
// run = { frames: [], subs: Set<fn>, done, promise, startedAt }. Повторный
// запрос того же тикера подписывается на уже идущий прогон (лок 02 §1.3).
const active = new Map();

// подписка на идущий прогон (или null)
function subscribeRun(key, onFrame) {
  const run = active.get(key);
  if (!run) return null;
  // replay истории + живые кадры
  for (const f of run.frames) { try { onFrame(f); } catch {} }
  run.subs.add(onFrame);
  return run;
}

// rf для WACC: из кэша макро-полосы (FRED DGS10), фоллбек 4.3%
function riskFreeRate() {
  const c = readCache('macro', 24 * HOUR);
  const item = c && Array.isArray(c.items) ? c.items.find(i => i.id === 'DGS10') : null;
  return item && Number.isFinite(item.value) ? item.value : 4.3;
}

// ── пиры (спека 02 §2.6): курируемая карта → фоллбек по сектору ──
async function gatherPeers(ds, manualPeers, { fetchImpl } = {}) {
  let list = (manualPeers || []).map(p => String(p).toUpperCase().trim()).filter(Boolean).slice(0, 4);
  if (!list.length) list = PEERS_MAP[ds.meta.ticker] || [];
  if (!list.length && ds.meta.sector) {
    const basket = Object.keys(SECTOR_OF_BASKET).find(b => SECTOR_OF_BASKET[b] === ds.meta.sector);
    const pool = basket ? universe(ds.meta.sector).filter(t => t !== ds.meta.ticker) : [];
    // 4 ближайших по капитализации (QuickInfo не тянем для всех — берём первые, у нас нет cap здесь);
    // экономим запросы: просто первые 4 кандидата корзины
    list = pool.slice(0, 4);
  }
  list = list.slice(0, 4);
  const rows = [];
  for (const p of list) {
    try {
      const q = await dataAgent.fetchQuick(p, { fetchImpl });
      if (!q) continue;
      const m = { pe_trailing: q.pe_trailing, pe_forward: q.pe_forward, ev_ebitda: q.ev_ebitda, roe: q.roe, revenue_growth: q.revenue_growth };
      if (Object.values(m).every(v => v == null)) continue; // пустые пиры выбрасываются
      rows.push({
        ticker: q.ticker, name: q.name, market_cap: q.market_cap, current_price: q.current_price,
        pe_trailing: q.pe_trailing, pe_forward: q.pe_forward, ev_ebitda: q.ev_ebitda,
        revenue_growth: q.revenue_growth, roe: q.roe, operating_margin: q.operating_margin,
      });
    } catch { /* пир не загрузился — не страшно */ }
  }
  return { peers: rows.map(r => r.ticker), peers_comparison: rows };
}

// ── канонический пересчёт MoS (03 §3.9): единственный источник истины ──
function canonicalMos(val, price) {
  if (val.dcf_base == null || !(price > 0)) return val;
  const mos = Math.round(((val.dcf_base - price) / price) * 1000) / 10;
  val.margin_of_safety_pct = mos;
  val.mos = mos;
  val.valuation_score = intrinsic.marginOfSafetyScore(mos);
  val.score = val.valuation_score;
  return val;
}

// ── EQUITY-пайплайн (02 §2.1) ──
async function runEquity(ds, fm, { fetchImpl, llm, onFrame, T }) {
  const step = (name, status, data) => onFrame({ step: name, status, data: data || {} });
  let degraded = 0;

  // 2. SEC EDGAR (мягкая деградация)
  step('sec_filing', 'running');
  let sec = { data_available: false };
  try {
    sec = await fetchSecData(T, { fetchImpl, llm });
  } catch { sec = { ticker: T, data_available: false }; }
  step('sec_filing', 'done', {
    revenue_change: sec.revenue_change_pct, margin: sec.operating_margin,
    insider_signal: sec.recent_form4?.activity_signal || 'none',
    '8k_events': (sec.recent_8k_events || []).length,
  });

  // 3. news radar + event-флаги D1–D4
  step('news_radar', 'running');
  let news = { risk_level: 'unknown', events: [], summary: null };
  try {
    news = await fetchNegativeNews(T, ds.meta.name, { fetchImpl, llm });
  } catch { /* фоллбек из спеки */ }
  const lastFilingTs = Math.max(
    sec.last_10k_date ? Date.parse(sec.last_10k_date) : 0,
    sec.last_10q_date ? Date.parse(sec.last_10q_date) : 0,
  ) || null;
  const event_flags = decision.computeEventFlags({
    news, lastFilingTs: lastFilingTs || null, ret90d: ds.price_hist?.ret_90d ?? null,
  });
  step('news_radar', 'done', {
    level: news.risk_level, stale: event_flags.stale_filing,
    ma: event_flags.active_ma_offer, unexplained: event_flags.unexplained_move,
  });

  // 4. financial (уже посчитан детерминированно)
  step('financial', 'done', { growth_score: fm.growth_score });

  // 5. business (LLM)
  step('business', 'running');
  const business = await agents.businessAgent(ds, fm, { llm });
  if (business._fallback) degraded++;
  step('business', 'done', { moat: business.moat_type, score: business.business_score });

  // 6. valuation: детерминированный движок + LLM-нарратив
  step('valuation', 'running');
  const val = intrinsic.compute(ds, fm, { rf: riskFreeRate() });
  const narrative = await agents.valuationNarrative(ds, fm, val, business, { llm });
  Object.assign(val, narrative); // нарратив не меняет числа (поля не пересекаются)
  step('valuation', 'done', { base: val.dcf_base, mos: val.margin_of_safety_pct });

  // 7. market sentiment (без LLM)
  step('market_sentiment', 'running');
  const sentiment = await marketSentiment(ds, { fetchImpl });
  step('market_sentiment', 'done', {
    short_signal: sentiment.short_interest?.signal || null,
    options_signal: sentiment.options_sentiment?.signal || null,
    days_to_earnings: sentiment.earnings_data?.days_until_earnings ?? null,
  });

  // 8. risk (LLM, последовательно ради памяти)
  step('risk_analysis', 'running');
  const risk = await agents.riskAgent({ ds, fm, business, val, sec, sentiment }, { llm });
  if (risk._fallback) degraded++;
  sentiment.sentiment_interpretation = risk.sentiment_interpretation || null;
  step('risk_analysis', 'done', { mispricing: risk.mispricing_type, risk_score: risk.risk_score });

  // канонический пересчёт MoS ПОСЛЕ LLM-фазы (03 §3.9)
  canonicalMos(val, ds.meta.current_price);

  // 9. decision (LLM self-critique при высокой уверенности — внутри decide)
  step('decision', 'running');
  const pre = decision.decide({ ds, fm, business, valuation: val, risk, sec, event_flags, degraded_agents: degraded });
  let critique = null;
  if (pre.confidence_pct >= 80) {
    critique = await agents.selfCritique({
      t: T, verdict: pre.verdict, conf: pre.confidence_pct, mos: val.margin_of_safety_pct,
      risk, business, sec,
    }, { llm });
  }
  const dec = critique
    ? decision.decide({ ds, fm, business, valuation: val, risk, sec, event_flags, degraded_agents: degraded, self_critique: critique })
    : pre;
  step('decision', 'done', { verdict: dec.verdict, score: dec.total_score, confidence: dec.confidence_pct });

  return { sec, news, event_flags, business, val, sentiment, risk, dec, degraded };
}

// ── DIVIDEND-пайплайн (04 §4.9): cashflow → quality → risk → valuation → portfolio → decision ──
function cashflowAnalysis(ds, fm) {
  const fcf = (ds.derived?.free_cash_flow || []).filter(v => Number.isFinite(v));
  const dps = ds.dividend_data?.annual_dps || 0;
  const cover = [];
  const years = ds.derived?.year || [];
  for (let i = 0; i < Math.min(fcf.length, years.length, 5); i++) {
    if (fcf[i] > 0 && dps > 0) cover.push(fcf[i] / dps);
  }
  const half = Math.ceil(Math.min(fcf.length, 4) / 2);
  const recent = fcf.slice(0, half), older = fcf.slice(half, half * 2);
  const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    avg_fcf_coverage: cover.length ? +(cover.reduce((s, x) => s + x, 0) / cover.length).toFixed(2) : null,
    fcf_trend: recent.length && older.length && avg(older) > 0
      ? (avg(recent) > avg(older) * 1.1 ? 'improving' : avg(recent) < avg(older) * 0.9 ? 'declining' : 'stable')
      : 'unknown',
    fcf_positive_years: fcf.filter(v => v > 0).length,
    fcf_available_years: fcf.length,
    dividend_covered_by_fcf: cover.length ? cover[0] >= 1 : null,
  };
}

async function runDividend(ds, fm, { fetchImpl, llm, onFrame, T }) {
  const step = (name, status, data) => onFrame({ step: name, status, data: data || {} });
  let degraded = 0;

  step('cashflow', 'running');
  const cf = cashflowAnalysis(ds, fm);
  const yieldTrap = (ds.dividend_data?.yield || 0) >= 0.08 && (cf.avg_fcf_coverage != null && cf.avg_fcf_coverage < 1.2);
  step('cashflow', 'done', { coverage: cf.avg_fcf_coverage, trend: cf.fcf_trend });

  step('quality', 'running');
  const quality = await agents.divQuality(ds, fm, { llm });
  if (quality._fallback) degraded++;
  quality.payout_ratio = ds.dividend_data?.payout_ratio ?? null;
  quality.payout_sustainability = cf.avg_fcf_coverage != null
    ? (cf.avg_fcf_coverage >= 2 ? 'strong' : cf.avg_fcf_coverage >= 1.2 ? 'adequate' : 'weak')
    : 'unknown';
  quality.yield_trap_flag = !!yieldTrap;
  step('quality', 'done', { dividend_type: quality.dividend_type, safety: quality.dividend_safety });

  step('risk', 'running');
  const risk = await agents.divRisk(ds, fm, quality, { llm });
  if (risk._fallback) degraded++;
  step('risk', 'done', { cut_risk: risk.cut_risk_pct });

  step('valuation', 'running');
  const valuation = await agents.divValuation(ds, fm, { llm });
  if (valuation._fallback) degraded++;
  step('valuation', 'done', { yoc3: valuation.yield_on_cost_3y, total_return: valuation.total_return_estimate });

  step('portfolio', 'running');
  const portfolio = await agents.divPortfolio(ds, fm, quality, risk, valuation, { llm });
  if (portfolio._fallback) degraded++;
  step('portfolio', 'done', { role: portfolio.portfolio_role, allocation: portfolio.suggested_allocation_pct });

  // decision: композит = качество 0–10 · 3 + безопасность payout · 2 + (100−cut_risk)/10 · 3 + YoC-апсайд · 2
  step('decision', 'running');
  const payoutSafe = quality.payout_sustainability === 'strong' ? 9 : quality.payout_sustainability === 'adequate' ? 6 : quality.payout_sustainability === 'weak' ? 2 : 5;
  const yocUpside = Math.round(clamp01((valuation.yield_on_cost_3y - (ds.dividend_data?.yield || 0)) * 20 + 5, 0, 10));
  let score = quality.dividend_safety * 3 + payoutSafe * 2 + ((100 - risk.cut_risk_pct) / 10) * 3 + yocUpside * 2;
  if (quality.yield_trap_flag) score -= 15;
  if (degraded > 0) score -= 5 * degraded;
  score = Math.round(Math.min(100, Math.max(0, score)));
  let verdict = score >= 75 ? 'Strong Income Buy' : score >= 60 ? 'Income Buy' : score >= 40 ? 'Hold' : 'Avoid';
  if (degraded > 0 && (verdict === 'Strong Income Buy' || verdict === 'Income Buy')) verdict = 'Hold';
  if (risk.cut_risk_pct > 60 && verdict !== 'Avoid') verdict = 'Hold';
  const dec = {
    total_score: score, verdict, confidence_pct: Math.round(Math.max(20, Math.min(90, 75 - 10 * degraded - (quality.yield_trap_flag ? 15 : 0)))),
    time_horizon: '3-5 years',
    forward_yield_3y: valuation.yield_on_cost_3y,
    expected_total_return: valuation.total_return_estimate,
    component_scores: {
      dividend_quality: quality.dividend_safety * 10,
      payout_safety: payoutSafe * 10,
      cut_risk: 100 - risk.cut_risk_pct,
      income_upside: yocUpside * 10,
    },
  };
  step('decision', 'done', { verdict, score, confidence: dec.confidence_pct });

  return { cashflow_analysis: cf, dividend_quality: quality, dividend_risk: risk, dividend_valuation: valuation, portfolio_guidance: portfolio, dec, degraded };
}

const clamp01 = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ── запись исхода вердикта (02 §2.8, калибровка на будущее) ──
function recordOutcome(ticker, verdict, conf, score, price) {
  try {
    const p = process.env.EQUITY_OUTCOMES_FILE
      || path.join(__dirname, '..', '..', 'data', 'analysis-outcomes.jsonl');
    fs.appendFileSync(p, JSON.stringify({
      ticker, analyzed_at: Date.now(), verdict, confidence: conf,
      total_score: score, price_at_analysis: price,
    }) + '\n');
  } catch { /* исходы не критичны */ }
}

// ── главный вход: анализ с кадрами; возвращает результат ──
// opts: { type: 'equity'|'dividend', peers, llm, fetchImpl, force, onFrame }
async function analyze(ticker, opts = {}) {
  const T = String(ticker || '').toUpperCase().trim().slice(0, 10);
  if (!/^[A-Z0-9.\-]+$/.test(T)) throw new Error('некорректный тикер');
  const type = opts.type === 'dividend' ? 'dividend' : 'equity';
  const startedAt = Date.now();
  const onFrame = opts.onFrame || (() => {});

  onFrame({ step: 'init', status: 'done', data: { ticker: T, type } });

  // 1. data_fetch — фатальный шаг
  onFrame({ step: 'data_fetch', status: 'running', data: {} });
  const ds = await dataAgent.fetchFull(T, { fetchImpl: opts.fetchImpl });
  if (!ds.meta?.current_price) throw new Error(`${T}: нет цены — анализ невозможен`);
  onFrame({ step: 'data_fetch', status: 'done', data: { name: ds.meta.name } });

  const fm = computeMetrics(ds);

  let out;
  if (type === 'equity') {
    out = await runEquity(ds, fm, { fetchImpl: opts.fetchImpl, llm: opts.llm, onFrame, T });
    // пиры — таблица контекста (не входит в оценку)
    const peersInfo = await gatherPeers(ds, opts.peers, { fetchImpl: opts.fetchImpl });
    out.peersBlock = peersInfo;
  } else {
    out = await runDividend(ds, fm, { fetchImpl: opts.fetchImpl, llm: opts.llm, onFrame, T });
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  onFrame({ step: 'complete', status: 'done', data: { elapsed_seconds: +elapsed.toFixed(1) } });

  const result = {
    ticker: T, name: ds.meta.name, sector: ds.meta.sector, industry: ds.meta.industry,
    current_price: ds.meta.current_price, market_cap: ds.meta.market_cap,
    enterprise_value: ds.meta.enterprise_value, currency: ds.meta.currency, beta: ds.meta.beta,
    multiples: ds.multiples,
    analyst: ds.analyst,
    financial_metrics: fm,
    agents_failed: out.degraded,
    analyzed_at: Math.floor(startedAt / 1000),
    elapsed_seconds: +elapsed.toFixed(1),
  };
  if (type === 'equity') {
    Object.assign(result, {
      business_analysis: out.business,
      valuation: out.val,
      risk_thesis: out.risk,
      decision: out.dec,
      news_radar: { risk_level: out.news.risk_level, events: out.news.events, summary: out.news.summary },
      event_flags: out.event_flags,
      sec_filing_data: out.sec,
      market_sentiment: out.sentiment,
      series: {
        revenue: ds.derived.revenue, free_cash_flow: ds.derived.free_cash_flow,
        operating_margin: ds.derived.operating_margin, roic: ds.derived.roic,
        net_income: ds.derived.net_income,
      },
      peers: out.peersBlock.peers,
      peers_comparison: out.peersBlock.peers_comparison,
      valuation_framing: out.val.framing,
    });
    recordOutcome(T, out.dec.verdict, out.dec.confidence_pct, out.dec.total_score, ds.meta.current_price);
  } else {
    Object.assign(result, {
      cashflow_analysis: out.cashflow_analysis,
      dividend_quality: out.dividend_quality,
      dividend_risk: out.dividend_risk,
      dividend_valuation: out.dividend_valuation,
      portfolio_guidance: out.portfolio_guidance,
      decision: out.dec,
      dividend_data: ds.dividend_data,
    });
    recordOutcome(T, out.dec.verdict, out.dec.confidence_pct, out.dec.total_score, ds.meta.current_price);
  }

  onFrame({ step: 'result', status: 'done', data: result });
  return { result, degraded: out.degraded };
}

// ── прогон с кэшем и подписчиками ──
// Кэш-ключ — {ticker, lang}: ручные пиры не фрагментируют кэш (в оценку не
// входят), поэтому /result по тикеру всегда находит запись (08 §8.1).
// startAnalysis возвращает { run } — run.promise → result либо реджект.
function startAnalysis(ticker, opts = {}) {
  const type = opts.type === 'dividend' ? 'dividend' : 'equity';
  const T = String(ticker || '').toUpperCase().trim();
  const cacheName = `eq-res-${analysisKey(type === 'equity' ? 'equity' : 'dividend', { ticker: T, lang: 'ru' })}`;

  if (!opts.force) {
    const c = readCache(cacheName, HOUR);
    if (c) return { fromCache: true, result: c, cacheName };
  } else {
    try { fs.rmSync(path.join(__dirname, '..', '..', 'data', 'cache', cacheName + '.json')); } catch {}
  }

  const existing = active.get(T + ':' + type);
  if (existing) return { run: existing, cacheName };

  const run = { frames: [], subs: new Set(), done: false, startedAt: Date.now(), promise: null };
  active.set(T + ':' + type, run);
  run.promise = (async () => {
    try {
      const onFrame = f => {
        run.frames.push(f);
        for (const fn of run.subs) { try { fn(f); } catch {} }
      };
      const { result, degraded } = await analyze(T, { ...opts, type, onFrame });
      if (degraded < 2) writeCache(cacheName, result); // ≥2 упавших — не кэшируем (08 §8.1)
      run.done = true;
      return result;
    } catch (e) {
      const errFrame = { step: 'error', status: 'failed', data: { error: e.message, ticker: T } };
      run.frames.push(errFrame);
      for (const fn of run.subs) { try { fn(errFrame); } catch {} }
      run.done = true;
      throw e;
    } finally {
      active.delete(T + ':' + type);
    }
  })();
  return { run, cacheName };
}

// восстановление после обрыва (08 §8.1): только чтение кэша, MISS → null
function cachedResult(ticker, type = 'equity') {
  const T = String(ticker || '').toUpperCase().trim();
  const cacheName = `eq-res-${analysisKey(type === 'equity' ? 'equity' : 'dividend', { ticker: T, lang: 'ru' })}`;
  return { data: readCache(cacheName, HOUR), cacheName };
}

module.exports = { analyze, startAnalysis, cachedResult, canonicalMos, cashflowAnalysis, analysisKey, riskFreeRate, subscribeRun };
