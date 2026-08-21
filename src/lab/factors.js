// #1 факторная декомпозиция + #9 стресс-корреляции: чистая математика
// над выровненной матрицей цен. I/O (заливка/кэш) — ниже в этом же файле.
const { ridgeSolve, standardizeCols, jacobiEigen } = require('../math/linalg');
const { pearson, spearman, entropy } = require('../math/stats');

const FACTOR_PROXIES = ['SMH', 'XLK', 'URA', 'MOO', 'GLD', 'XLE', 'IWM', 'TLT', 'UUP', 'SPY'];
const WINDOW = 60;        // дней в окне ридж-регрессии
const STEP = 5;           // шаг скользящего окна
const STRESS_RET = -0.02; // день рынка хуже −2% — стресс
const LAMBDA_SCALE = 1e-4;// ридж: λ = LAMBDA_SCALE × n

const logRet = px => px.slice(1).map((v, i) => Math.log(v / px[i]));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

function analyzeFactorModel({ prices, positions, factors = FACTOR_PROXIES, market = 'SPY' }) {
  const tickers = positions.map(p => p.t);
  const R = {};
  for (const t of [...tickers, ...factors, market]) if (!R[t]) R[t] = logRet(prices[t]);
  const T = R[factors[0]].length;

  // #1: скользящие окна → ридж-беты (последнее окно + σβ по окнам).
  // Регрессия идёт по стандартизованным факторам, но беты переводятся
  // в сырые единицы (β на 1% фактора) делением на σ фактора окна.
  const betas = {};
  for (const t of tickers) {
    const wins = [];
    for (let start = 0; start + WINDOW <= T; start += STEP) {
      const X = [], y = [];
      for (let i = start; i < start + WINDOW; i++) {
        X.push(factors.map(f => R[f][i]));
        y.push(R[t][i]);
      }
      const { Z, sds } = standardizeCols(X);
      const bStd = ridgeSolve(Z, y, LAMBDA_SCALE * WINDOW);
      wins.push(factors.map((f, j) => (sds[j] > 0 ? bStd[j] / sds[j] : 0)));
    }
    const last = wins[wins.length - 1];
    const out = { beta: {}, sigma: {} };
    factors.forEach((f, j) => {
      out.beta[f] = last[j];
      out.sigma[f] = sd(wins.map(w => w[j]));
    });
    betas[t] = out;
  }

  // экспозиция портфеля = Σ wᵢβᵢ (+ разбивка по тегам-бакетам)
  const totalVal = positions.reduce((s, p) => s + p.val, 0);
  const exposure = {}, byTag = {};
  for (const f of factors) exposure[f] = 0;
  for (const p of positions) {
    const w = totalVal > 0 ? p.val / totalVal : 0;
    for (const f of factors) {
      exposure[f] += w * betas[p.t].beta[f];
      byTag[p.tag] = byTag[p.tag] || {};
      byTag[p.tag][f] = (byTag[p.tag][f] || 0) + w * betas[p.t].beta[f];
    }
  }

  // PCA корреляционной матрицы позиций → эффективное число ставок
  const n = tickers.length;
  const corrM = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    corrM[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = pearson(R[tickers[i]], R[tickers[j]]) ?? 0;
      corrM[i][j] = corrM[j][i] = c;
    }
  }
  const eig = jacobiEigen(corrM).filter(v => v > 1e-9);
  const s = eig.reduce((a, v) => a + v, 0);
  const enb = s > 0 ? Math.exp(entropy(eig.map(v => v / s))) : tickers.length;

  // #9: условные корреляции и коэффициент диверсификации
  const mkt = R[market];
  const stressIdx = [], normIdx = [];
  for (let i = 0; i < T; i++) (mkt[i] < STRESS_RET ? stressIdx : normIdx).push(i);
  const pick = (a, idx) => idx.map(i => a[i]);
  const weights = positions.map(p => (totalVal > 0 ? p.val / totalVal : 0));
  const portRet = Array.from({ length: T }, (_, i) =>
    positions.reduce((s2, p, k) => s2 + weights[k] * R[p.t][i], 0));
  const regimes = {
    stress: { n: stressIdx.length, corr: {}, dr: null, thresholdPct: STRESS_RET * 100 },
    normal: { n: normIdx.length, corr: {}, dr: null },
  };
  for (const [regime, idx] of [[regimes.stress, stressIdx], [regimes.normal, normIdx]]) {
    if (idx.length < 10) continue; // слишком мало дней — не считаем
    for (const t of tickers) regime.corr[t] = spearman(pick(R[t], idx), pick(mkt, idx)) ?? 0;
    const sumW = weights.reduce((s2, w, k) => s2 + w * sd(pick(R[tickers[k]], idx)), 0);
    regime.dr = sumW > 0 ? sd(pick(portRet, idx)) / sumW : null;
  }
  const corrJump = tickers
    .map(t => ({ t, jump: (regimes.stress.corr[t] ?? 0) - (regimes.normal.corr[t] ?? 0) }))
    .sort((a, b) => b.jump - a.jump);

  return {
    window: WINDOW, tickers, factors, betas, exposure, byTag,
    enb, eig, stress: regimes.stress, normal: regimes.normal, corrJump,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { FACTOR_PROXIES, WINDOW, STEP, STRESS_RET, analyzeFactorModel };
