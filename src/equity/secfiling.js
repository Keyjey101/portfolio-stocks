// SEC EDGAR-агент (спека 02 §2.3): XBRL-метрики по одному концепту, даты 10-K/10-Q,
// Form 4 (инсайдеры), 8-K события, MD&A 10-K → LLM-саммари. Кэш 6 ч; «нет CIK»
// тоже кэшируется. 13F-институционалы не снимаем — блок честно пустой.
// UA обязателен, пауза 0.15 с между запросами.

const { readCache, writeCache } = require('./../cache');
const { getTickerMap } = require('./../edgar');
const { mdaSummary } = require('./agents');

const HOUR = 3600e3;
const TTL = 6 * HOUR;
const UA = { 'User-Agent': 'portfolio-terminal/1.0 (personal research)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`EDGAR: HTTP ${r.status} ${url.slice(0, 60)}`);
  return r.json();
}

// ── submissions (полное, без фильтра форм) ──
async function submissions(cik, { fetchImpl, cacheName }) {
  const cached = readCache(cacheName, 6 * HOUR);
  if (cached) return cached;
  const j = await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { fetchImpl });
  writeCache(cacheName, j);
  return j;
}

function recentRows(j) {
  const r = j?.filings?.recent;
  if (!r || !Array.isArray(r.form)) return [];
  return r.form.map((form, i) => ({
    form,
    date: r.filingDate?.[i] || null,
    items: String(r.items?.[i] || ''),
    acc: String(r.accessionNumber?.[i] || '').replace(/-/g, ''),
    doc: r.primaryDocument?.[i] || null,
    reportDate: r.reportDate?.[i] || null,
  }));
}

// ── XBRL: один концепт, только годовые факты (10-K/20-F, длительность 300–400 дн) ──
const CONCEPTS = [
  { key: 'Revenues', aliases: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'] },
  { key: 'OperatingIncomeLoss', aliases: ['OperatingIncomeLoss'] },
  { key: 'NetIncomeLoss', aliases: ['NetIncomeLoss'] },
  { key: 'EPS', aliases: ['EarningsPerShareBasic'] },
  { key: 'LongTermDebt', aliases: ['LongTermDebt', 'LongTermDebtNoncurrent'] },
  { key: 'ShortTermBorrowings', aliases: ['ShortTermBorrowings', 'DebtCurrent'] },
  { key: 'StockholdersEquity', aliases: ['StockholdersEquity'] },
  { key: 'OperatingCashFlow', aliases: ['NetCashProvidedByUsedInOperatingActivities'] },
  { key: 'Capex', aliases: ['PaymentsToAcquirePropertyPlantAndEquipment'] },
];

async function conceptAnnual(cik, name, { fetchImpl }) {
  const j = await getJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${name}.json`, { fetchImpl });
  const facts = j?.units?.[j.units && Object.keys(j.units)[0]] || [];
  const annual = [], quarterly = [];
  for (const f of facts) {
    if (!['10-K', '20-F', '10-K/A', '20-F/A'].includes(f.form)) {
      if (['10-Q', '10-Q/A'].includes(f.form)) quarterly.push(f);
      continue;
    }
    const start = Date.parse(f.start), end = Date.parse(f.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const days = (end - start) / 864e5;
    if (days < 300 || days > 400) continue;
    annual.push({ year: new Date(end).getUTCFullYear(), end: f.end, val: f.val, filed: f.filed });
  }
  annual.sort((a, b) => b.year - a.year);
  quarterly.sort((a, b) => String(b.end).localeCompare(String(a.end)));
  return { annual: annual.slice(0, 5), quarterly: quarterly.slice(0, 8).map(q => ({
    end: q.end, val: q.val, form: q.form,
  })) };
}

async function xbrlMetrics(cik, { fetchImpl }) {
  const out = {};
  for (const c of CONCEPTS) {
    for (const alias of c.aliases) {
      try {
        const { annual, quarterly } = await conceptAnnual(cik, alias, { fetchImpl });
        if (annual.length) { out[c.key] = { series: annual, source: alias }; if (c.key === 'Revenues') out.Revenues_quarterly = quarterly; break; }
      } catch { /* концепт не заводится — пробуем алиас */ }
      await sleep(150);
    }
    await sleep(150);
  }
  return out;
}

const yoy = series => {
  if (!series || series.length < 2) return null;
  const [a, b] = series;
  return b.val !== 0 ? ((a.val - b.val) / Math.abs(b.val)) * 100 : null;
};

// ── Form 4: инсайдерские сделки (≤10 за 90 дней, XML) ──
function parseForm4Xml(xml) {
  const code = (xml.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/) || [])[1];
  const shares = parseFloat((xml.match(/<transactionShares>\s*<value>\s*([\d.]+)/) || [])[1]);
  const price = parseFloat((xml.match(/<transactionPricePerShare>\s*<value>\s*([\d.]+)/) || [])[1]);
  const date = (xml.match(/<transactionDate>\s*<value>\s*([\d-]+)/) || [])[1];
  return { code, shares, price, date };
}

async function form4Activity(cik, rows, { fetchImpl }) {
  const now = Date.now();
  const f4 = rows.filter(r => r.form === '4' && r.date && Date.parse(r.date) > now - 90 * 864e5
    && Date.parse(r.date) <= now && r.acc && r.doc).slice(0, 10);
  let buyCount = 0, sellCount = 0, buyVal = 0, sellVal = 0, largest = 0;
  const filings = [];
  for (const r of f4) {
    await sleep(150);
    try {
      const url = `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, '')}/${r.acc}/${r.doc}`;
      const resp = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const { code, shares, price } = parseForm4Xml(await resp.text());
      if (code === 'P' && shares > 0) { buyCount++; buyVal += shares * (price || 0); }
      else if (code === 'S' && shares > 0) { sellCount++; sellVal += shares * (price || 0); }
      const v = shares * (price || 0);
      if (v > largest) largest = v;
      filings.push({ date: r.date, code, shares, price });
    } catch { /* один битый XML не рушит блок */ }
  }
  let activity_signal = 'none';
  const trades = buyCount + sellCount;
  if (buyVal > 2 * Math.max(1, sellVal) && buyCount > 0) activity_signal = 'buying_pressure';
  else if (sellVal > 3 * Math.max(1, buyVal) && sellCount > 0) activity_signal = 'heavy_selling';
  else if (trades > 5) activity_signal = 'elevated';
  else if (trades > 0) activity_signal = 'normal';
  return {
    buy_count: buyCount, sell_count: sellCount, activity_signal,
    total_buy_value_usd: Math.round(buyVal), total_sell_value_usd: Math.round(sellVal),
    largest_single_transaction_usd: Math.round(largest),
    form4_filings: filings.slice(0, 5),
  };
}

// ── 8-K: классификация по item'ам ──
function classify8k(items) {
  const has = it => items.includes(it);
  if (has('4.02')) return { event_type: 'restatement', description: 'Пересмотр финансовой отчётности (restatement)' };
  if (has('2.02')) return { event_type: 'earnings', description: 'Результаты квартала (8-K, item 2.02)' };
  if (has('2.05') || has('2.06')) return { event_type: 'guidance', description: 'Затраты/реструктуризация, влияние на прогноз (8-K)' };
  if (has('5.02')) return { event_type: 'leadership_change', description: 'Смена руководства/директоров (8-K, item 5.02)' };
  if (has('1.01')) return { event_type: 'material_agreement', description: 'Существенное соглашение (8-K, item 1.01)' };
  if (has('1.05')) return { event_type: 'bankruptcy', description: 'Банкротство/неплатёжеспособность (8-K)' };
  return { event_type: 'other', description: 'Прочее событие (8-K)' };
}

// ── MD&A из 10-K: ограниченная выгрузка + LLM-саммари ──
const stripTags = html => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

async function fetchMdaText(cik, row, { fetchImpl }) {
  if (!row || !row.acc || !row.doc) return null;
  const url = `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, '')}/${row.acc}/${row.doc}`;
  const resp = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) return null;
  const html = (await resp.text()).slice(0, 2_500_000); // потолок выгрузки
  const text = stripTags(html);
  const i7 = text.search(/item\s*7[\.\s:]/i);
  const i8 = text.search(/item\s*8[\.\s:]/i);
  let mda = i7 >= 0 ? text.slice(i7, i8 > i7 ? i8 : i7 + 15000) : text.slice(0, 15000);
  // риски — Item 1A
  const i1a = text.search(/item\s*1a[\.\s:]/i);
  const risks = i1a >= 0 ? text.slice(i1a, i1a + 15000) : '';
  return { mda: mda.slice(0, 15000), risks: risks.slice(0, 15000) };
}

// кейворд-фоллбек тона (спека §2.3 п.7)
function toneByWords(text) {
  const t = String(text || '').toLowerCase();
  const neg = (t.match(/risk|decline|adverse|challenge|uncertain|pressure|impairment|loss/g) || []).length;
  const pos = (t.match(/growth|opportunity|strength|expand|record|improve|margin increase/g) || []).length;
  if (neg > pos * 2) return 'negative';
  if (neg > pos) return 'cautious';
  if (pos > neg * 2) return 'positive';
  if (pos > neg) return 'cautiously_optimistic';
  return 'neutral';
}

// ── главный вход ──
async function fetchSecData(ticker, { fetchImpl = fetch, llm = null } = {}) {
  const T = String(ticker).toUpperCase();
  const cacheName = `eq-sec-${T.replace(/[^A-Z0-9.-]/g, '_')}`;
  const cached = readCache(cacheName, TTL);
  if (cached) return cached;

  const map = await getTickerMap({ fetchImpl });
  const cik = map[T];
  if (!cik) {
    const out = { ticker: T, cik: null, data_available: false };
    writeCache(cacheName, out);
    return out;
  }

  const subs = await submissions(cik, { fetchImpl, cacheName: `edgar-subs-${cik}` });
  const rows = recentRows(subs);

  const last10k = rows.find(r => r.form === '10-K' || r.form === '20-F');
  const last10q = rows.find(r => r.form === '10-Q');
  const last10kTs = last10k?.date ? Date.parse(last10k.date) : null;
  const staleWarning = last10kTs != null && Date.now() - last10kTs > 15 * 30.4 * 864e5
    ? 'Последний 10-K старше 15 месяцев — данные могли устареть' : null;

  // XBRL-метрики (могут частично отсутствовать — это норма)
  let xb = {};
  try { xb = await xbrlMetrics(cik, { fetchImpl }); } catch { /* частичный блок */ }

  const revS = xb.Revenues?.series, niS = xb.NetIncomeLoss?.series, epsS = xb.EPS?.series;
  const ltD = xb.LongTermDebt?.series, stB = xb.ShortTermBorrowings?.series, eqS = xb.StockholdersEquity?.series;
  const ocfS = xb.OperatingCashFlow?.series, capexS = xb.Capex?.series;
  const debt0 = (ltD?.[0]?.val ?? 0) + (stB?.[0]?.val ?? 0);
  const debt1 = (ltD?.[1]?.val ?? 0) + (stB?.[1]?.val ?? 0);
  const opMargin = revS?.[0]?.val ? (xb.OperatingIncomeLoss?.series?.[0]?.val ?? null) / revS[0].val * 100 : null;
  const opMargin1 = revS?.[1]?.val ? (xb.OperatingIncomeLoss?.series?.[1]?.val ?? null) / revS[1].val * 100 : null;
  const fcf0 = ocfS?.[0]?.val != null ? ocfS[0].val - Math.abs(capexS?.[0]?.val ?? 0) : null;
  const fcf1 = ocfS?.[1]?.val != null ? ocfS[1].val - Math.abs(capexS?.[1]?.val ?? 0) : null;

  // инсайдеры и 8-K
  let form4 = { buy_count: 0, sell_count: 0, activity_signal: 'none', total_buy_value_usd: 0, total_sell_value_usd: 0, largest_single_transaction_usd: 0, form4_filings: [] };
  try { form4 = await form4Activity(cik, rows, { fetchImpl }); } catch { /* блок опционален */ }

  const now = Date.now();
  const events8k = rows
    .filter(r => r.form === '8-K' && r.date && Date.parse(r.date) > now - 180 * 864e5)
    .slice(0, 5)
    .map(r => ({ date: r.date, items: r.items, ...classify8k(r.items) }));

  // MD&A + LLM-саммари (фоллбек — кейворды)
  let mda = null, top_risks = null, filing_tone = null;
  try {
    const text = await fetchMdaText(cik, last10k, { fetchImpl });
    if (text) {
      const llmOut = llm && text.mda
        ? await mdaSummary(text.mda.slice(0, 12000), text.risks.slice(0, 6000), { llm }).catch(() => null)
        : null;
      if (llmOut) {
        mda = llmOut.mda_summary; top_risks = llmOut.top_risks; filing_tone = llmOut.filing_tone;
      } else {
        mda = text.mda.slice(0, 500);
        const sentences = (text.risks.match(/[^.!?]{60,400}[.!?]/g) || []).slice(0, 5);
        top_risks = sentences.map(s => s.trim());
        filing_tone = toneByWords(text.mda);
      }
    }
  } catch { /* MD&A опционален */ }

  const hasAny = revS || niS || last10k || events8k.length || form4.buy_count + form4.sell_count > 0;
  const out = {
    ticker: T, cik, data_available: !!hasAny,
    revenue_change_pct: revS ? +yoy(revS).toFixed(1) : null,
    net_income_change_pct: niS ? +yoy(niS).toFixed(1) : null,
    eps_change_pct: epsS ? +yoy(epsS).toFixed(1) : null,
    debt_to_equity: eqS?.[0]?.val > 0 ? +(debt0 / (debt0 + eqS[0].val)).toFixed(2) : null, // D/(D+E)
    debt_change_pct: debt1 !== 0 ? +(((debt0 - debt1) / Math.abs(debt1)) * 100).toFixed(1) : null,
    operating_margin: opMargin != null ? +opMargin.toFixed(1) : null,
    margin_change: opMargin != null && opMargin1 != null ? +(opMargin - opMargin1).toFixed(1) : null,
    free_cash_flow: fcf0, 
    fcf_change_pct: fcf0 != null && fcf1 != null && fcf1 !== 0 ? +(((fcf0 - fcf1) / Math.abs(fcf1)) * 100).toFixed(1) : null,
    last_10k_date: last10k?.date || null,
    last_10q_date: last10q?.date || null,
    recent_8k_events: events8k,
    recent_form4: form4,
    xbrl_metrics: Object.fromEntries(Object.entries(xb).filter(([k]) => !k.includes('quarterly'))
      .map(([k, v]) => [k, v.series?.slice(0, 3)])),
    quarterly_series: { Revenues: (xb.Revenues_quarterly || []).map(q => ({ val: q.val, end: q.end, form: q.form })) },
    institutional_changes: { notable_activity: null, recent_filings_count: null },
    mda_summary: mda, top_risks: top_risks, filing_tone,
    filing_staleness_warning: staleWarning,
  };
  writeCache(cacheName, out);
  return out;
}

module.exports = { fetchSecData, classify8k, parseForm4Xml, toneByWords, recentRows };
