// #8 мониторинг капитального цикла (сторона предложения):
// композит из бесплатных рыночных рядов (RS60 SOX/URA/полуоборудование к SPY,
// уровень TLT) + капекс гиперскейлеров из XBRL-фактов EDGAR (без LLM — ноль
// галлюцинаций) + ручной слот цен аренды GPU.
const fs = require('fs');
const path = require('path');
const { loadPrices, alignPrices } = require('./factors');
const { readCache, writeCache } = require('../cache');

const ROOT = path.join(__dirname, '..', '..');
const CC_DIR = path.join(ROOT, 'data', 'capcycle');
const HIST_FILE = path.join(CC_DIR, 'history.json');
const GPU_FILE = path.join(CC_DIR, 'gpu.json');

const HYPERSCALERS = [
  { t: 'MSFT', cik: '0000789019' },
  { t: 'GOOGL', cik: '0001652044' },
  { t: 'AMZN', cik: '0001018729' },
  { t: 'META', cik: '0001326801' },
  { t: 'ORCL', cik: '0001341439' },
];

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};

function zscore(xs) {
  const m = mean(xs), s = sd(xs);
  return xs.map(v => (s > 0 ? (v - m) / s : 0));
}

// RS60-нога: z текущего отношения к его 60-дн истории
function legZ(numer, denom) {
  const ratio = numer.map((v, i) => v / denom[i]);
  const z = zscore(ratio.slice(-60));
  return z.at(-1);
}

function buildComposite(prices) {
  const semi = prices.AMAT.map((v, i) => (v + prices.LRCX[i] + prices.KLAC[i]) / 3);
  const legs = {
    '^SOX/SPY': legZ(prices['^SOX'], prices.SPY),
    'URA/SPY': legZ(prices.URA, prices.SPY),
    'SEMI/SPY': legZ(semi, prices.SPY),
    'TLT': zscore(prices.TLT.slice(-60)).at(-1),
  };
  const composite = mean(Object.values(legs));
  return { legs, composite, stage: stageOf(composite) };
}

function stageOf(composite) {
  if (composite < -0.5) return 0;
  if (composite < 0) return 1;
  if (composite < 0.5) return 2;
  return 3;
}

// kill-switch «2 из 3»: сколько ног с z < −1 (сжатие спроса-прокси)
function killSwitchLegs(legs) {
  const down = Object.entries(legs).filter(([k, z]) => k !== 'TLT' && z < -1).map(([k]) => k);
  return { count: down.length, legs: down };
}

// ── капекс из XBRL (us-gaap:PaymentsToAcquirePropertyPlantAndEquipment) ──
function parseCapex(j) {
  const rows = j?.units?.USD;
  if (!Array.isArray(rows) || !rows.length) return null;
  const annuals = rows
    .filter(r => r.form === '10-K' && r.start && r.end)
    .map(r => {
      const days = (Date.parse(r.end) - Date.parse(r.start)) / 864e5;
      return days >= 350 && days <= 380 ? { end: r.end, val: r.val } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.end.localeCompare(b.end));
  if (annuals.length < 2) return null;
  const last = annuals.at(-1), prev = annuals.at(-2);
  return { annuals, ttm: last.val, ttmGrowth: (last.val / prev.val - 1) * 100 };
}

const CAPEX_CONCEPTS = [
  'PaymentsToAcquirePropertyPlantAndEquipment',
  'PaymentsToAcquireProductiveAssets', // Amazon и часть старых филлингов
];

async function fetchCapex({ fetchImpl = fetch } = {}) {
  const UA = { 'User-Agent': 'portfolio-terminal/1.0 (personal research)' };
  const out = [];
  for (const h of HYPERSCALERS) {
    let p = null, lastErr = 'нет данных';
    for (const concept of CAPEX_CONCEPTS) {
      try {
        const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${h.cik}/us-gaap/${concept}.json`;
        const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(30000) });
        if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
        p = parseCapex(await r.json());
        if (p) break;
      } catch (e) { lastErr = e.message; }
    }
    out.push(p ? { t: h.t, ttm: p.ttm, growth: +p.ttmGrowth.toFixed(1) } : { t: h.t, error: lastErr });
    await new Promise(res => setTimeout(res, 500)); // бережём EDGAR
  }
  const ok = out.filter(x => x.growth != null);
  return { companies: out, avgGrowth: ok.length ? ok.reduce((s, x) => s + x.growth, 0) / ok.length : null };
}

// ── ручной слот цен аренды GPU ──
function addGpuRent(usd) {
  const v = +usd;
  if (!(v > 0)) throw new Error('цена должна быть > 0');
  fs.mkdirSync(CC_DIR, { recursive: true });
  const list = readGpu();
  list.push({ date: new Date().toISOString(), usdPerGpuHour: v });
  fs.writeFileSync(GPU_FILE, JSON.stringify(list, null, 2));
  return list.at(-1);
}
const readGpu = () => { try { return JSON.parse(fs.readFileSync(GPU_FILE, 'utf8')); } catch { return []; } };

// ── сборка + месячная история + кэш 7 дней ──
const UNIVERSE = ['^SOX', 'URA', 'AMAT', 'LRCX', 'KLAC', 'SPY', 'TLT'];

async function runCapcycle({ force = false, fetchImpl = fetch } = {}) {
  if (!force) {
    const cached = readCache('capcycle', 7 * 864e5);
    if (cached) return { ...cached, cached: true };
  }
  const raw = await loadPrices(UNIVERSE, '1y');
  const aligned = alignPrices(raw);
  if (!aligned.SPY || !aligned['^SOX'] || aligned['^SOX'].length < 80) throw new Error('capcycle: нет рыночных рядов');
  const comp = buildComposite(aligned);
  const capex = await fetchCapex({ fetchImpl });
  const gpu = readGpu();

  // история: одна точка на месяц
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
  const monthKey = new Date().toISOString().slice(0, 7);
  history = history.filter(h => h.month !== monthKey);
  history.push({ month: monthKey, composite: +comp.composite.toFixed(3), stage: comp.stage });
  fs.mkdirSync(CC_DIR, { recursive: true });
  fs.writeFileSync(HIST_FILE, JSON.stringify(history, null, 2));

  const res = {
    generatedAt: new Date().toISOString(),
    legs: comp.legs, composite: +comp.composite.toFixed(3), stage: comp.stage,
    stageLabel: ['сжатие', 'охлаждение', 'расширение', 'перегрев'][comp.stage],
    killSwitch: killSwitchLegs(comp.legs),
    capex, gpuRent: gpu.at(-1) || null, gpuHistory: gpu.slice(-12), history,
  };
  writeCache('capcycle', res);
  return { ...res, cached: false };
}

module.exports = { zscore, buildComposite, stageOf, killSwitchLegs, parseCapex, fetchCapex, addGpuRent, readGpu, runCapcycle };
