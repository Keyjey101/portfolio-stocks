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

module.exports = { matrixPower, simulateMC };
