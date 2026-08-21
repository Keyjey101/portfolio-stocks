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

module.exports = { computeResiduals, detectFlags };
