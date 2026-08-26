'use strict';
// Рантест пайплайна оценки: фикстурный fetch (Yahoo/EDGAR/опционы/RSS) и
// фейковый LLM → полный analyze() с кадрами, результат, кэш, восстановление;
// плюс dividend-скан и гейтинг страниц в server.handle().
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// изолируем артефакты от боевых data/
process.env.EQUITY_OUTCOMES_FILE = path.join(__dirname, '..', 'data', 'cache', '.eq-outcomes-test.jsonl');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

// ── фикстуры Yahoo ──
function stmtEntry(end, rev, oi, ni, ebitda, eps, ie) {
  const R = v => ({ raw: v, fmt: String(v) });
  return { end: { fmt: end }, totalRevenue: R(rev), grossProfit: R(rev * 0.45),
    operatingIncome: R(oi), netIncome: R(ni), ebitda: R(ebitda), interestExpense: R(ie), dilutedEPS: R(eps) };
}
function balEntry(end, debt, eq, cash) {
  const R = v => ({ raw: v, fmt: String(v) });
  return { end: { fmt: end }, totalDebt: R(debt), totalStockholderEquity: R(eq), totalAssets: R(debt + eq + cash), cashCashEquivalents: R(cash) };
}
function cfEntry(end, ocf, capex) {
  const R = v => ({ raw: v, fmt: String(v) });
  return { end: { fmt: end }, totalCashFromOperatingActivities: R(ocf), capitalExpenditure: R(capex), dividendsPaid: R(-ocf * 0.1) };
}
const INCOME = [], BAL = [], CF = [];
for (let i = 0; i < 6; i++) {
  const y = 2026 - i;
  const rev = 50e9 * Math.pow(1.08, 5 - i);
  INCOME.push(stmtEntry(`${y}-12-31`, rev, rev * 0.25, rev * 0.2, rev * 0.3, rev * 0.2 / 1e9, rev * 0.01));
  BAL.push(balEntry(`${y}-12-31`, rev * 0.3, rev * 0.5, rev * 0.1));
  CF.push(cfEntry(`${y}-12-31`, rev * 0.26, -rev * 0.05));
}

function quoteSummaryJson(T) {
  return { quoteSummary: { result: [{
    price: { longName: 'Test Widget Co', shortName: 'TestWidget', quoteType: 'EQUITY', marketCap: { raw: 115e9 }, regularMarketPrice: { raw: 115 } },
    summaryDetail: { currency: 'USD', marketCap: { raw: 115e9 }, averageVolume: { raw: 12e6 },
      fiftyTwoWeekHigh: { raw: 140 }, fiftyTwoWeekLow: { raw: 80 }, trailingPE: { raw: 23 }, beta: { raw: 1.1 },
      dividendYield: { raw: 0.004 }, dividendRate: { raw: 0.44 }, payoutRatio: { raw: 0.09 } },
    defaultKeyStatistics: { sharesOutstanding: { raw: 1e9 }, floatShares: { raw: 0.98e9 }, enterpriseValue: { raw: 118e9 },
      trailingEps: { raw: 5 }, forwardEps: { raw: 5.6 }, beta: { raw: 1.1 }, financialCurrency: 'USD',
      priceToBook: { raw: 4.6 }, enterpriseToEbitda: { raw: 16 }, sharesShort: { raw: 8e6 }, shortRatio: { raw: 0.7 } },
    financialData: { currentPrice: { raw: 115 }, totalDebt: { raw: 16e9 }, totalCash: { raw: 5e9 }, ebitda: { raw: 16e9 },
      revenueGrowth: { raw: 0.08 }, grossMargins: { raw: 0.45 }, operatingMargins: { raw: 0.25 }, profitMargins: { raw: 0.2 },
      returnOnEquity: { raw: 0.4 }, returnOnAssets: { raw: 0.2 }, freeCashflow: { raw: 10.5e9 },
      targetMeanPrice: { raw: 130 }, targetHighPrice: { raw: 150 }, targetLowPrice: { raw: 100 },
      recommendationKey: 'buy', numberOfAnalystOpinions: { raw: 24 } },
    summaryProfile: { sector: 'Technology', industry: 'Software - Infrastructure', country: 'US', exchange: 'NMS' },
    assetProfile: { longBusinessSummary: 'Test Widget Co делает виджеты с высокой маржой и повторяющейся выручкой.' },
    calendarEvents: { earnings: { earningsDate: [{ raw: Math.floor(Date.now() / 1000) + 45 * 86400 }] }, exDividendDate: { fmt: '2026-09-01' } },
    earningsHistory: { history: [
      { surprisePercent: { raw: 3.2 } }, { surprisePercent: { raw: 1.1 } },
      { surprisePercent: { raw: -0.4 } }, { surprisePercent: { raw: 2.5 } },
    ] },
    earningsTrend: { trend: [
      { period: '0q', growth: null }, { period: '+1y', growth: { raw: 0.12 } }, { period: '+5y', growth: { raw: 0.10 } },
    ] },
    incomeStatementHistory: { incomeStatementHistory: INCOME },
    balanceSheetHistory: { balanceSheetHistory: BAL },
    cashflowStatementHistory: { cashflowStatementHistory: CF },
    recommendationTrend: { trend: [{ period: '0m', strongBuy: 10, buy: 9, hold: 4, sell: 1, strongSell: 0 }] },
  }] } };
}

function chartJson() {
  const closes = [];
  let p = 90;
  for (let i = 0; i < 250; i++) { closes.push(+(p).toFixed(2)); p *= 1 + 0.002; }
  closes[249] = 115;
  return { chart: { result: [{ meta: { regularMarketPrice: 115, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 80 },
    timestamp: closes.map((_, i) => 1e9 + i * 86400), indicators: { quote: [{ close: closes }] },
    events: { dividends: { 1: { date: 1e9, amount: 0.11 }, 2: { date: 1e9 + 86400 * 365, amount: 0.11 } } } }] } };
}
function optionsJson() {
  const calls = [], puts = [];
  for (let k = 90; k <= 140; k += 5) {
    calls.push({ strike: k, volume: 1000, openInterest: 5000, impliedVolatility: 0.25 });
    puts.push({ strike: k, volume: 600, openInterest: 4000, impliedVolatility: 0.28 });
  }
  return { optionChain: { result: [{ expirationDates: [Math.floor(Date.now() / 1000) + 20 * 86400], options: [{ calls, puts }] }] } };
}

// ── фикстурный fetch ──
function fixtureFetch(T) {
  return async (url) => {
    const s = String(url);
    if (s.includes('fc.yahoo.com')) {
      return { ok: false, status: 404, headers: { getSetCookie: () => ['A3=x; Path=/'] }, text: async () => '' };
    }
    if (s.includes('getcrumb')) return { ok: true, status: 200, text: async () => 'crumb123' };
    if (s.includes('quoteSummary')) return { ok: true, status: 200, json: async () => quoteSummaryJson(T) };
    if (s.includes('fundamentals-timeseries')) return { ok: true, status: 200, json: async () => ({ timeseries: { result: [] } }) };
    if (s.includes('/chart/')) return { ok: true, status: 200, json: async () => chartJson() };
    if (s.includes('/v7/finance/options/')) return { ok: true, status: 200, json: async () => optionsJson() };
    if (s.includes('feeds.finance.yahoo.com')) return { ok: true, status: 200, text: async () => '<rss><channel></channel></rss>' };
    if (s.includes('newsapi.org')) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
    if (s.includes('company_tickers.json')) {
      return { ok: true, status: 200, json: async () => ({ '0': { cik_str: 320193, ticker: T, title: 'Test Widget Co' } }) };
    }
    if (s.includes('data.sec.gov/submissions')) {
      const now = Date.now();
      const d = i => new Date(now - i * 30 * 864e5).toISOString().slice(0, 10);
      return { ok: true, status: 200, json: async () => ({ filings: { recent: {
        form: ['10-K', '10-Q', '8-K', '4'], filingDate: [d(2), d(1), d(1), d(0)],
        items: ['2.02,9.01', '', '7.01', ''],
        accessionNumber: ['0001-22-000001', '0001-22-000002', '0001-22-000003', '0001-22-000004'],
        primaryDocument: ['a.htm', 'b.htm', 'c.htm', 'd.xml'],
        reportDate: [d(70), d(2), '', ''],
      } } }) };
    }
    if (s.includes('companyconcept')) {
      const concept = s.match(/us-gaap\/([A-Za-z]+)\.json/)[1];
      const facts = [];
      for (let i = 1; i <= 3; i++) {
        const y = 2026 - i;
        facts.push({ form: '10-K', start: `${y - 1}-01-01`, end: `${y}-12-31`, val: 40e9 * i * (concept === 'Revenues' ? 1 : 0.2), filed: `${y}-02-01`, fy: y, fp: 'FY' });
      }
      return { ok: true, status: 200, json: async () => ({ units: { USD: facts } }) };
    }
    if (s.includes('sec.gov/Archives')) {
      if (s.endsWith('.xml')) {
        return { ok: true, status: 200, text: async () => '<ownershipDocument><transactionDate><value>2026-08-01</value></transactionDate>'
          + '<transactionCoding><transactionCode>P</transactionCode></transactionCoding>'
          + '<transactionAmounts><transactionShares><value>10000</value></transactionShares>'
          + '<transactionPricePerShare><value>50</value></transactionPricePerShare></transactionAmounts></ownershipDocument>' };
      }
      return { ok: true, status: 200, text: async () => '<html><body>ITEM 7. Management discussion. Revenue grew steadily on strong demand for widgets. ITEM 1A. Risk factors include competition and supply chain.</body></html>' };
    }
    throw new Error('фикстура не знает URL: ' + s.slice(0, 80));
  };
}

// ── фейковый LLM: раздаёт валидные ответы по task ──
function fakeLlm() {
  const calls = [];
  return {
    calls,
    chat: async (messages, { task } = {}) => {
      calls.push(task);
      const R = {
        eqBusiness: { business_model: 'Платформенная модель.', revenue_type: 'recurring', moat_type: 'network_effect',
          moat_description: 'Сетевой эффект.', moat_score: 8, industry_trend: 'growing', industry_cyclicality: 'secular',
          industry_score: 7, business_score: 8, key_insights: ['Рост'], concerns: ['Конкуренция'] },
        eqValuation: { relative_assessment: 'Мультипликаторы умеренные.', valuation_narrative: 'Оценка интерпретирована.',
          dcf_assumptions: 'g/WACC из модели', is_cyclically_adjusted: false },
        eqRisk: { why_cheap_or_expensive: 'Дешева из-за сектора.', is_temporary_or_structural: 'temporary',
          what_market_misses: 'Повторяющуюся выручку', mispricing_type: 'opportunity', catalysts: ['Отчёт'],
          key_risks: ['Конкуренция'], time_horizon: '3-5 years', thesis_summary: 'Качество со скидкой.',
          risk_score: 3, sec_filing_assessment: 'Чисто.', sentiment_interpretation: 'Спокойно.' },
        eqMda: { mda_summary: 'Выручка растёт.', top_risks: ['Конкуренция', 'Цикл'], filing_tone: 'neutral' },
        eqCritique: { bear_case: 'Рецессия ударит.', confidence_adjustment: -5, missed_risks: ['Валюта'], final_assessment: 'caution' },
        eqAdvisor: { summary: 'Компании объединяет высокая маржа. Смотрите на долг.' },
        eqNews: { risk_level: 'none', events: [], summary: 'Негатива нет.' },
        divQuality: { dividend_type: 'dividend_growth', dividend_safety: 8, growth_sustainability: 7, notes: 'Стабильный плательщик.' },
        divRisk: { cut_risk_pct: 10, yield_trap_probability: 8, primary_risk_type: 'циклический', rationale: 'Покрытие большое.' },
        divValuation: { yield_on_cost_3y: 0.006, yield_on_cost_5y: 0.007, expected_dps_growth_rate: 0.06, total_return_estimate: 0.09, rationale: 'Умеренно.' },
        divPortfolio: { portfolio_role: 'growth_income', suggested_allocation_pct: 3, allocation_rationale: 'Дополняет ядро.' },
      };
      const out = R[task] || {};
      return JSON.parse(JSON.stringify(out));
    },
  };
}

// ── прогон ──
test('analyze(): полный equity-прогон на фикстурах', async () => {
  // другие тесты могли закэшировать свою карту тикеров EDGAR — наша фикстура
  // отдаёт company_tickers.json только для своих тикеров, сбрасываем общий кэш
  try { fs.unlinkSync(path.join(CACHE_DIR, 'edgar-map.json')); } catch {}
  const { analyze } = require('../src/equity/orchestrator');
  const frames = [];
  const llm = fakeLlm();
  const { result } = await analyze('TSTQ', {
    type: 'equity', llm, fetchImpl: fixtureFetch('TSTQ'),
    onFrame: f => frames.push(f),
  });
  const steps = frames.filter(f => f.status === 'done').map(f => f.step);
  for (const want of ['init', 'data_fetch', 'financial', 'business', 'valuation', 'decision', 'complete', 'result']) {
    assert.ok(steps.includes(want), `шаг ${want}: ${steps.join(',')}`);
  }
  assert.strictEqual(result.ticker, 'TSTQ');
  assert.ok(result.valuation.dcf_base > 0, 'base посчитан');
  assert.ok(result.valuation.methods.length >= 3, 'методы в результате');
  assert.ok(['Strong Buy', 'Buy', 'Hold', 'Avoid', 'No Decision'].includes(result.decision.verdict));
  assert.strictEqual(result.agents_failed, 0, 'агенты живы');
  assert.ok(result.peers_comparison.length > 0, 'пиры собраны');
  assert.ok(result.sec_filing_data.data_available, 'SEC блок есть');
  assert.ok(result.market_sentiment.short_interest, 'short interest есть');
  // LLM-вызовы: бизнес, нарратив, риск (+MDA); self-critique — по уверенности
  assert.ok(llm.calls.includes('eqBusiness') && llm.calls.includes('eqValuation') && llm.calls.includes('eqRisk'));
  // канонический MoS пересчитан из dcf_base
  const mos = Math.round(((result.valuation.dcf_base - 115) / 115) * 1000) / 10;
  assert.strictEqual(result.valuation.margin_of_safety_pct, mos);
});

test('startAnalysis(): кэш 1 ч, повтор из кэша, /result отдаёт', async () => {
  const orch = require('../src/equity/orchestrator');
  const cacheFileBefore = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('eq-res-')).length;
  const frames = [];
  const p = orch.startAnalysis('TSTC', { type: 'equity', llm: fakeLlm(), fetchImpl: fixtureFetch('TSTC'), onFrame: f => frames.push(f) });
  assert.ok(p.run, 'прогон запущен');
  const res = await p.run.promise;
  assert.ok(res.valuation, 'результат получен');
  const cacheFileAfter = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('eq-res-')).length;
  assert.ok(cacheFileAfter > cacheFileBefore, 'кэш записан');
  const again = orch.startAnalysis('TSTC', { type: 'equity', llm: fakeLlm(), fetchImpl: fixtureFetch('TSTC') });
  assert.ok(again.fromCache, 'повтор — из кэша');
  const rec = orch.cachedResult('TSTC', 'equity');
  assert.ok(rec.data && rec.data.ticker === 'TSTC', 'recovery-эндпоинт находит');
  const miss = orch.cachedResult('NOSUCH', 'equity');
  assert.strictEqual(miss.data, null, 'MISS → null → 204');
});

test('analyze(): dividend-ветка', async () => {
  const { analyze } = require('../src/equity/orchestrator');
  const frames = [];
  const llm = fakeLlm();
  const { result } = await analyze('TSTD', {
    type: 'dividend', llm, fetchImpl: fixtureFetch('TSTD'),
    onFrame: f => frames.push(f),
  });
  const steps = frames.map(f => f.step);
  for (const want of ['cashflow', 'quality', 'risk', 'valuation', 'portfolio', 'decision']) {
    assert.ok(steps.includes(want), `див. шаг ${want}`);
  }
  assert.ok(['Strong Income Buy', 'Income Buy', 'Hold', 'Avoid'].includes(result.decision.verdict));
  assert.ok(result.cashflow_analysis && result.dividend_quality && result.portfolio_guidance);
});

test('startScan(): dividend-скан по фикстурам → completed + camelCase', async () => {
  const sc = require('../src/equity/scanner');
  const llm = fakeLlm();
  const { scanId } = sc.startScan({ scanType: 'dividend', topN: 5 }, { fetchImpl: fixtureFetch('ANYQ'), llm });
  let st = null;
  for (let i = 0; i < 120 && (!st || st.status === 'running'); i++) {
    await new Promise(r => setTimeout(r, 50));
    st = sc.getStatus(scanId);
  }
  assert.strictEqual(st.status, 'completed', `статус: ${JSON.stringify(st)}`);
  const res = sc.getResults(scanId);
  assert.ok(res && res.results, 'результаты есть');
  if (res.results.length) {
    const r = res.results[0];
    assert.ok(r.ticker && r.currentPrice != null, 'camelCase-строка');
    assert.ok(r.valuation && r.scores && r.keyMetrics && r.redFlags, 'вложенные блоки контракта');
    assert.strictEqual(r.valuation.verdict, 'DIVIDEND CANDIDATE');
  }
  assert.ok(typeof res.advisor === 'string', 'советник есть');
});

test('server.handle(): страницы и API за паролем', async () => {
  process.env.APP_PASSWORD = 'test-pass-eq';
  const { handle } = require('../src/server');
  const auth = require('../src/auth');
  // чистим кэш-файлы фикстурных прогонов, чтобы гейт-тест не тратил лимитер
  const mkRes = () => {
    const r = { headersSent: false, statusCode: 0, body: '', headers: {},
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; this.headersSent = true; return this; },
      end(x) { this.body = x == null ? '' : String(x); this.ended = true; return this; },
      write(x) { this.chunks = (this.chunks || '') + String(x); return true; } };
    return r;
  };
  const reqOf = (url, { method = 'GET', owner = false } = {}) => ({
    url, method,
    headers: owner ? { cookie: 'pt_auth=' + auth.signToken(3600e3) } : {},
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  });
  // гость → гейт-страница 403 (страница читается с диска асинхронно — ждём тик)
  let res = mkRes();
  await handle(reqOf('/stock-analysis'), res);
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(res.statusCode, 403);
  assert.ok(String(res.body).includes('Закрытый раздел'), 'гейт-страница');
  // владелец → страница
  res = mkRes();
  await handle(reqOf('/market-scanner', { owner: true }), res);
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(String(res.body).includes('Сканер сектора'));
  // гость не запускает анализ
  res = mkRes();
  await handle(reqOf('/api/equity/analyze/AAPL/stream'), res);
  assert.strictEqual(res.statusCode, 401);
  // секторы отдаются
  res = mkRes();
  await handle(reqOf('/api/equity/sectors'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).sectors.length === 11);
  delete process.env.APP_PASSWORD;
});

after(() => {
  // уборка фикстурных артефактов
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (/^eq-res-|^eq-quick-|^eq-scan-|^eq-sec-|^edgar-subs-|^edgar-map|^\.eq-outcomes/.test(f)) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
      }
    }
    fs.unlinkSync(process.env.EQUITY_OUTCOMES_FILE);
    const scansDir = path.join(__dirname, '..', 'data', 'scans');
    if (fs.existsSync(scansDir)) for (const f of fs.readdirSync(scansDir)) fs.unlinkSync(path.join(scansDir, f));
  } catch {}
});
