// #4 Монте-Карло: чистое ядро симуляции (блочный бутстрап + марковские режимы).
// I/O (заливка, HMM, worker) — runMC ниже.
const { lcg, quantile } = require('../math/stats');

function matrixPower(M, p) {
  const n = M.length;
  let R = M.map(r => r.slice());
  for (let i = 1; i < p; i++) {
    const N = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let c = 0; c < n; c++) s += R[a][c] * M[c][b];
        N[a][b] = s;
      }
    R = N;
  }
  return R;
}

function sampleDisc(probs, u) {
  let acc = 0;
  for (let j = 0; j < probs.length; j++) {
    acc += probs[j];
    if (u < acc) return j;
  }
  return probs.length - 1;
}

// pools: массив по состояниям из дневных лог-доходностей;
// A — дневная матрица переходов (месячная = A²¹); довнесение в конце месяца;
// просадка по месячным срезам (гранулярность задокументирована в UI)
function simulateMC({ pools, A, pi, years, monthlyUsd = 0, startValue = 1, paths = 2000, seed = 1 }) {
  const rnd = lcg(seed);
  const k = pools.length;
  const Am = matrixPower(A, 21);
  const months = Math.round(years * 12);
  const BLOCK = 21;
  const terminal = new Array(paths), maxDD = new Array(paths);
  const yearly = Array.from({ length: years }, () => new Array(paths));

  for (let p = 0; p < paths; p++) {
    let state = sampleDisc(pi, rnd());
    let v = startValue, peak = v, dd = 0;
    for (let m = 0; m < months; m++) {
      state = sampleDisc(Am[state], rnd());
      const pool = pools[state] || pools[0];
      const maxStart = Math.max(1, pool.length - BLOCK + 1);
      const start = Math.floor(rnd() * maxStart);
      let lr = 0;
      for (let i = 0; i < BLOCK; i++) lr += pool[start + i] || 0;
      v = v * Math.exp(lr) + monthlyUsd;
      if (v > peak) peak = v;
      const d = (peak - v) / peak;
      if (d > dd) dd = d;
      if ((m + 1) % 12 === 0) yearly[((m + 1) / 12) - 1][p] = v;
    }
    terminal[p] = v;
    maxDD[p] = dd;
  }

  const q = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return { p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95) };
  };
  const terminalSorted = [...terminal].sort((a, b) => a - b);
  return {
    terminal: q(terminal),
    terminalSorted,
    maxDD: q(maxDD),
    yearly: yearly.map(y => q(y)),
    totalContrib: monthlyUsd * months,
  };
}

// ── I/O: сбор данных (2y), HMM-режимы, worker, еженедельный кэш ──
const path = require('path');
const { Worker } = require('worker_threads');
const { loadPrices, alignPrices } = require('./factors');
const { positions: defaultPositions } = require('../portfolio');
const { readCache, writeCache } = require('../cache');
const { standardizeCols } = require('../math/linalg');
const { selectHMM } = require('../math/hmm');
const { loadEnv } = require('../env');

const WEEK = 7 * 24 * 3600e3;
const LAG = 20;

const num = (v, dflt) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

async function buildMCData({ positionsLoader = defaultPositions } = {}) {
  const list = (await positionsLoader()).filter(p => p.qty > 0 || p.t === 'ITOT');
  const universe = [...new Set([...list.map(p => p.t), '^GSPC', '^VIX', '^TNX'])];
  const raw = await loadPrices(universe, '2y');
  const aligned = alignPrices(raw);
  if (!aligned['^GSPC'] || !aligned['^VIX'] || !aligned['^TNX']) throw new Error('MC: нет рыночных рядов');

  const okList = list.filter(p => aligned[p.t] && aligned[p.t].length > 60);
  const vals = okList.map(p => (p.qty || 0) * aligned[p.t].at(-1));
  const totalVal = vals.reduce((s, v) => s + v, 0);
  const w = vals.map(v => (totalVal > 0 ? v / totalVal : 0));

  const T = aligned['^GSPC'].length - 1; // число дневных доходностей
  const port = Array.from({ length: T }, (_, i) =>
    okList.reduce((s, p, j) => s + w[j] * Math.log(aligned[p.t][i + 1] / aligned[p.t][i]), 0));

  const vix = aligned['^VIX'], tnx = aligned['^TNX'], spx = aligned['^GSPC'];
  const idx = [];
  for (let i = LAG; i < T; i++) idx.push(i);
  const X = idx.map(i => [vix[i], tnx[i] - tnx[i - LAG], Math.log(spx[i] / spx[i - LAG])]);
  const { Z } = standardizeCols(X);
  const { best } = selectHMM(Z, [2, 3]);
  const k = best.means.length;

  const pools = Array.from({ length: k }, () => []);
  best.states.forEach((s, j) => pools[s].push(port[idx[j]]));

  // стационарное распределение
  let pi = best.pi.slice();
  for (let it = 0; it < 200; it++) {
    pi = pi.map((_, i) => best.A.reduce((s2, row, j) => s2 + pi[j] * row[i], 0));
  }

  // статистики режимов в сырых единицах
  const cnt = new Array(k).fill(0);
  const sums = Array.from({ length: k }, () => [0, 0, 0]);
  best.states.forEach((s, j) => {
    cnt[s]++;
    for (let d = 0; d < 3; d++) sums[s][d] += X[j][d];
  });
  const stateStats = cnt.map((c, s) => ({
    share: c / cnt.reduce((a, b) => a + b, 0),
    vix: sums[s][0] / (c || 1),
    tnx20: sums[s][1] / (c || 1),
    spx20: sums[s][2] / (c || 1),
    days: pools[s].length,
  }));

  return { pools, A: best.A, pi, k, startValue: Math.round(totalVal), stateStats, nDays: T };
}

let inflight = null;

async function runMC({ force = false, inline = false, paths = 10000, seed = 7, positionsLoader } = {}) {
  if (!force) {
    const cached = readCache('mc', WEEK);
    if (cached) return { ...cached, cached: true };
    if (inflight) return inflight;
  }
  inflight = (async () => {
    const ENV = loadEnv();
    const monthlyUsd = num(process.env.MC_MONTHLY_USD ?? ENV.MC_MONTHLY_USD, 250);
    const years = Math.max(1, Math.round(num(process.env.MC_YEARS ?? ENV.MC_YEARS, 10)));
    const target = num(process.env.MC_TARGET_USD ?? ENV.MC_TARGET_USD, null);

    const data = await buildMCData({ positionsLoader });
    const params = { monthlyUsd, years, startValue: data.startValue, target, paths, seed };

    const mk = m => simulateMC({
      pools: data.pools, A: data.A, pi: data.pi,
      years, monthlyUsd: monthlyUsd * m, startValue: data.startValue, paths, seed,
    });
    let base, half, double;
    if (inline) {
      base = mk(1); half = mk(0.5); double = mk(2);
    } else {
      ({ base, half, double } = await new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, '..', 'workers', 'mc-worker.js'), {
          workerData: { pools: data.pools, A: data.A, pi: data.pi, years, monthlyUsd, startValue: data.startValue, paths, seed },
        });
        w.on('message', resolve);
        w.on('error', reject);
      }));
    }

    let targetProb = null;
    if (target != null) {
      const arr = base.terminalSorted;
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
      targetProb = 1 - lo / arr.length;
    }

    const res = {
      generatedAt: new Date().toISOString(),
      params, k: data.k, stateStats: data.stateStats, nDays: data.nDays,
      base, sens: { half: half.terminal, base: base.terminal, double: double.terminal },
      targetProb,
    };
    writeCache('mc', res);
    return { ...res, cached: false };
  })();
  try { return await inflight; } finally { inflight = null; }
}

module.exports = { matrixPower, simulateMC, buildMCData, runMC };
