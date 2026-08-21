// Гауссов HMM с диагональной ковариацией: EM со скейлингом (Рабинер).
// Признаки предполагаются стандаризованными. Без зависимостей.

const LOG2PI = Math.log(2 * Math.PI);

function emitLogP(x, mean, vars) {
  let lp = 0;
  for (let d = 0; d < x.length; d++) {
    const v = vars[d];
    const z = (x[d] - mean[d]) / Math.sqrt(v);
    lp += -0.5 * (LOG2PI + Math.log(v) + z * z);
  }
  return lp;
}

// scaled forward-backward: α̂, β̂, логарифм правдоподобия, γ
function forwardBackward(X, pi, A, means, vars) {
  const n = X.length, k = pi.length;
  const B = new Array(n);
  for (let t = 0; t < n; t++) {
    B[t] = new Array(k);
    for (let j = 0; j < k; j++) B[t][j] = emitLogP(X[t], means[j], vars[j]);
  }
  const alpha = new Array(n), beta = new Array(n), c = new Array(n);
  for (let t = 0; t < n; t++) { alpha[t] = new Array(k); beta[t] = new Array(k); }
  for (let j = 0; j < k; j++) alpha[0][j] = pi[j] * Math.exp(B[0][j]);
  c[0] = alpha[0].reduce((s, v) => s + v, 0) || 1e-300;
  for (let j = 0; j < k; j++) alpha[0][j] /= c[0];
  for (let t = 1; t < n; t++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += alpha[t - 1][i] * A[i][j];
      alpha[t][j] = s * Math.exp(B[t][j]);
    }
    c[t] = alpha[t].reduce((s, v) => s + v, 0) || 1e-300;
    for (let j = 0; j < k; j++) alpha[t][j] /= c[t];
  }
  beta[n - 1].fill(1);
  for (let t = n - 2; t >= 0; t--)
    for (let i = 0; i < k; i++) {
      let s = 0;
      for (let j = 0; j < k; j++) s += A[i][j] * Math.exp(B[t + 1][j]) * beta[t + 1][j];
      beta[t][i] = s / c[t + 1];
    }
  const gamma = new Array(n);
  for (let t = 0; t < n; t++) {
    gamma[t] = new Array(k);
    let s = 0;
    for (let j = 0; j < k; j++) { gamma[t][j] = alpha[t][j] * beta[t][j]; s += gamma[t][j]; }
    for (let j = 0; j < k; j++) gamma[t][j] /= s || 1;
  }
  const ll = -c.reduce((s, v) => s + Math.log(v), 0);
  return { gamma, alpha, beta, B, ll };
}

function fitOnce(X, k, maxIter, tol) {
  const n = X.length, d = X[0].length;
  // init: квантильные корзины по признаку 0 — хорошо ложится на режимы волатильности
  const order = X.map((x, i) => [x[0], i]).sort((a, b) => a[0] - b[0]);
  const states0 = new Array(n);
  order.forEach(([, i], rank) => { states0[i] = Math.min(k - 1, Math.floor(rank * k / n)); });
  const pi = new Array(k).fill(1 / k);
  const A = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 0.9 : 0.1 / (k - 1))));
  const means = Array.from({ length: k }, () => new Array(d).fill(0));
  const vars = Array.from({ length: k }, () => new Array(d).fill(1));
  const initStats = () => {
    const cnt = new Array(k).fill(0);
    for (let t = 0; t < n; t++) cnt[states0[t]]++;
    for (let j = 0; j < k; j++) {
      for (let dd = 0; dd < d; dd++) {
        let m = 0;
        for (let t = 0; t < n; t++) if (states0[t] === j) m += X[t][dd];
        m /= cnt[j] || 1;
        means[j][dd] = m;
        let v = 0;
        for (let t = 0; t < n; t++) if (states0[t] === j) v += (X[t][dd] - m) ** 2;
        vars[j][dd] = Math.max(1e-6, v / (cnt[j] || 1));
      }
    }
  };
  initStats();

  let out = null, llPrev = -Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    out = forwardBackward(X, pi, A, means, vars);
    if (Math.abs(out.ll - llPrev) < tol * (1 + Math.abs(out.ll))) break;
    llPrev = out.ll;
    // M-step: π, средние/дисперсии
    for (let j = 0; j < k; j++) {
      let sw = 0;
      for (let t = 0; t < n; t++) sw += out.gamma[t][j];
      for (let dd = 0; dd < d; dd++) {
        let m = 0;
        for (let t = 0; t < n; t++) m += out.gamma[t][j] * X[t][dd];
        m /= sw || 1;
        means[j][dd] = m;
        let v = 0;
        for (let t = 0; t < n; t++) v += out.gamma[t][j] * (X[t][dd] - m) ** 2;
        vars[j][dd] = Math.max(1e-6, v / (sw || 1));
      }
    }
    // A: ξ_t(i,j) = α̂_t(i)·A_ij·b_j(t+1)·β̃_{t+1}(j) — при скейлинге Рабинера
    // Σ_{ij} ξ_t(i,j) = 1 уже по построению; построчная нормализация НЕ нужна
    // (она бы уничтожила вес γ_t(i) и выродила A в стационарные доли)
    for (let i = 0; i < k; i++) {
      const num = new Array(k).fill(0);
      let den = 0;
      for (let t = 0; t < n - 1; t++) {
        for (let j = 0; j < k; j++) {
          num[j] += out.alpha[t][i] * A[i][j] * Math.exp(out.B[t + 1][j]) * out.beta[t + 1][j];
        }
        den += out.gamma[t][i];
      }
      for (let j = 0; j < k; j++) A[i][j] = Math.max(1e-6, num[j] / (den || 1));
      const rs = A[i].reduce((s, v) => s + v, 0);
      for (let j = 0; j < k; j++) A[i][j] /= rs;
    }
  }
  out = forwardBackward(X, pi, A, means, vars);
  const states = out.gamma.map(g => g.indexOf(Math.max(...g)));
  const p = k * (k - 1) + (k - 1) + 2 * k * d;
  return { k, pi, A, means, vars, ll: out.ll, gamma: out.gamma, states, bic: -2 * out.ll + p * Math.log(n) };
}

function fitGaussianHMM(X, k, { maxIter = 120, tol = 1e-4 } = {}) {
  if (!X.length || k < 2) throw new Error('HMM: нужен непустой X и k ≥ 2');
  return fitOnce(X, k, maxIter, tol);
}

function selectHMM(X, ks = [2, 3], opts = {}) {
  const models = ks.map(k => fitGaussianHMM(X, k, opts));
  const best = models.reduce((a, m) => (m.bic < a.bic ? m : a));
  return { best, models };
}

module.exports = { fitGaussianHMM, selectHMM };
