// #2 детектор слома тезиса — чистая математика:
// факторные остатки (факт − Xβ) и флаги |r| > k·σ.
// I/O (сеть, LLM, кэш) — runDetector ниже.
const { ridgeSolve, standardizeCols } = require('../math/linalg');

const WINDOW = 60;
const LAMBDA_SCALE = 1e-4;

const logRet = px => px.slice(1).map((v, i) => Math.log(v / px[i]));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};

// беты последнего окна (ридж, как в factors.js) → остатки всей истории:
// r_t = ret_t − Σ_f β_f·ret_f,t (β в raw-единицах)
function computeResiduals({ prices, positions, factors, market = 'SPY' }) {
  const tickers = positions.map(p => p.t);
  const R = {};
  for (const t of [...tickers, ...factors, market]) if (!R[t]) R[t] = logRet(prices[t]);
  const T = R[factors[0]].length;

  const betas = {};
  for (const t of tickers) {
    const X = [], y = [];
    for (let i = T - WINDOW; i < T; i++) {
      X.push(factors.map(f => R[f][i]));
      y.push(R[t][i]);
    }
    const { Z, sds } = standardizeCols(X);
    const b = ridgeSolve(Z, y, LAMBDA_SCALE * WINDOW);
    betas[t] = factors.map((f, j) => (sds[j] > 0 ? b[j] / sds[j] : 0));
  }

  const residuals = {};
  for (const t of tickers) {
    residuals[t] = R[t].map((v, i) =>
      v - factors.reduce((s, f, j) => s + betas[t][j] * R[f][i], 0));
  }
  return { residuals, betas, factors };
}

// флаг: последний день |r| > k·σ или |r_5дн| > k·σ
function detectFlags(residuals, { k = 2.5, cum = 5 } = {}) {
  const out = {};
  for (const [t, r] of Object.entries(residuals)) {
    if (!r || r.length < cum + 2) {
      out[t] = { lastSigma: null, cumSigma: null, flag: false };
      continue;
    }
    const s = sd(r.slice(0, -1)); // σ без «подозреваемого» последнего дня
    const last = r.at(-1);
    const cumSum = r.slice(-cum).reduce((a, b) => a + b, 0);
    const lastSigma = s > 0 ? last / s : null;
    const cumSigma = s > 0 ? cumSum / (s * Math.sqrt(cum)) : null;
    out[t] = {
      lastSigma, cumSigma,
      flag: (lastSigma != null && Math.abs(lastSigma) > k)
        || (cumSigma != null && Math.abs(cumSigma) > k),
    };
  }
  return out;
}

// ── I/O: заливка, кэш 24 ч, cooldown 7 дн, LLM-атрибуция, recs.jsonl ──
const fs = require('fs');
const path = require('path');
const { loadPrices, alignPrices, FACTOR_PROXIES } = require('./factors');
const { positions: defaultPositions } = require('../portfolio');
const { readCache, writeCache } = require('../cache');
const { fetchHeadlines } = require('../news');
const { PROMPTS } = require('../prompts');
const { edgarRecent } = require('../edgar');
const defaultLlm = require('../llm');

const DAY = 24 * 3600e3;
const COOLDOWN = 7 * DAY;
const ATTR_DIR = path.join(__dirname, '..', '..', 'data', 'cache', 'attribution');
const RECS_FILE = path.join(__dirname, '..', '..', 'data', 'recs.jsonl');

function appendRec(rec) {
  try {
    fs.mkdirSync(path.dirname(RECS_FILE), { recursive: true });
    fs.appendFileSync(RECS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* лог не должен ломать детектор */ }
}

const VERDICT_SCHEMA = {
  verdict: 'enum:beta_move,idiosyncratic_temporary,thesis_damage',
  reason: 'string',
  pillar: 'string',
  confidence: 'number',
};

async function attribute(t, flag, meta, llm) {
  const [news, filings] = await Promise.all([
    fetchHeadlines(t).catch(() => []),
    edgarRecent(t).catch(() => []),
  ]);
  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.detector.system },
     { role: 'user', content: PROMPTS.detector.user({ t, meta, flag, news, filings }) }],
    { schema: VERDICT_SCHEMA, task: 'detector', t, temperature: 0.2 },
  );
  return { ...v, news, filings };
}

let inflight = null;

async function runDetector({ force = false, positionsLoader = defaultPositions,
  factors = FACTOR_PROXIES, market = 'SPY', llm = defaultLlm } = {}) {
  if (!force) {
    const cached = readCache('detector', DAY);
    if (cached) return { ...cached, cached: true };
    if (inflight) return inflight;
  }
  inflight = (async () => {
    const list = (await positionsLoader()).filter(p => p.qty > 0 || p.t === 'ITOT');
    const universe = [...new Set([...list.map(p => p.t), ...factors, market])];
    const raw = await loadPrices(universe, '1y');
    const aligned = alignPrices(raw);
    const okList = list.filter(p => aligned[p.t] && aligned[p.t].length > 90);
    const model = okList.map(p => ({ t: p.t, tag: p.tag, val: (p.qty || 0) * aligned[p.t].at(-1) }));

    const { residuals } = computeResiduals({ prices: aligned, positions: model, factors, market });
    const flags = detectFlags(residuals);

    const verdicts = [];
    const skipped = [];
    fs.mkdirSync(ATTR_DIR, { recursive: true });
    for (const p of okList) {
      if (!flags[p.t]?.flag) continue;
      const file = path.join(ATTR_DIR, `${p.t}.json`);
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!force && prev && Date.now() - Date.parse(prev.checkedAt) < COOLDOWN) {
        verdicts.push({ t: p.t, ...flags[p.t], ...prev, cooledDown: true });
        continue;
      }
      try {
        const v = await attribute(p.t, flags[p.t], p, llm); // p — слитая мета (дефолт + оверрайд агента)
        const rec = { t: p.t, ...flags[p.t], checkedAt: new Date().toISOString(), ...v };
        fs.writeFileSync(file, JSON.stringify(rec, null, 2));
        verdicts.push(rec);
        if (v.verdict === 'thesis_damage') appendRec({ kind: 'detector', t: p.t, verdict: v.verdict, reason: v.reason });
      } catch (e) {
        skipped.push({ t: p.t, error: e.message });
      }
    }

    const res = {
      generatedAt: new Date().toISOString(),
      flagsChecked: okList.length,
      verdicts, skipped,
    };
    writeCache('detector', res);
    return { ...res, cached: false };
  })();
  try { return await inflight; } finally { inflight = null; }
}

module.exports = { computeResiduals, detectFlags, runDetector };
