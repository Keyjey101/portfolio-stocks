// Временные ряды: Нелдер-Мид, GARCH(1,1), барьерная вероятность касания.
// Всё рукописное, без зависимостей; тесты — на синтетике с известными ответами.

const { normCdf } = require('./stats');

// ── Нелдер-Мид: минимизация без градиентов ──
function nelderMead(f, x0, { maxIter = 800, tol = 1e-9 } = {}) {
  const n = x0.length;
  const step = i => (x0[i] === 0 ? 0.05 : Math.abs(x0[i]) * 0.1);
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step(i); pts.push(p); }
  let vals = pts.map(f);
  const order = () => pts.map((_, i) => [vals[i], i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);

  for (let iter = 0; iter < maxIter; iter++) {
    const idx = order();
    const fs = idx.map(i => vals[i]);
    if (Math.max(...fs) - Math.min(...fs) < tol * (1 + Math.abs(fs[0]))) break;
    const worstI = idx[n], bestI = idx[0], secondI = idx[n - 1];
    const centroid = new Array(n).fill(0);
    for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) centroid[j] += pts[idx[k]][j] / n;
    const reflect = centroid.map((c, j) => c + (c - pts[worstI][j]));
    const fr = f(reflect);
    if (fr < vals[bestI]) {
      const expand = centroid.map((c, j) => c + 2 * (c - pts[worstI][j]));
      const fe = f(expand);
      if (fe < fr) { pts[worstI] = expand; vals[worstI] = fe; }
      else { pts[worstI] = reflect; vals[worstI] = fr; }
    } else if (fr < vals[secondI]) {
      pts[worstI] = reflect; vals[worstI] = fr;
    } else {
      const contract = centroid.map((c, j) => c + 0.5 * (pts[worstI][j] - c));
      const fc = f(contract);
      if (fc < vals[worstI]) { pts[worstI] = contract; vals[worstI] = fc; }
      else {
        for (let j = 1; j <= n; j++) {
          const ii = idx[j];
          pts[ii] = pts[bestI].map((b, d) => b + 0.5 * (pts[ii][d] - b));
          vals[ii] = f(pts[ii]);
        }
      }
    }
  }
  const idx = order();
  return { x: pts[idx[0]], fx: vals[idx[0]] };
}

// ── GARCH(1,1): квази-MLE Нелдером-Мидом ──
// Параметры через преобразование (гарантируют стационарность и позитивность):
//   ω = e^u, α = 0.98·σ(a), β = (1−α)·σ(b)
const sigmoid = x => 1 / (1 + Math.exp(-x));

function fitGARCH(rets) {
  const n = rets.length;
  const mu = rets.reduce((s, v) => s + v, 0) / n;
  const r = rets.map(v => v - mu);
  const var0 = r.reduce((s, v) => s + v * v, 0) / Math.max(1, n - 1);

  const negLL = p => {
    const omega = Math.exp(p[0]);
    const alpha = 0.98 * sigmoid(p[1]);
    const beta = (1 - alpha) * sigmoid(p[2]);
    let sig2 = var0, ll = 0;
    for (let t = 0; t < n; t++) {
      ll += 0.5 * (Math.log(2 * Math.PI) + Math.log(sig2) + r[t] * r[t] / sig2);
      sig2 = omega + alpha * r[t] * r[t] + beta * sig2;
    }
    return ll;
  };

  const starts = [[0.08, 0.90], [0.15, 0.80], [0.05, 0.70]].map(([al, be]) => {
    const om = Math.max(var0 * (1 - al - be), 1e-12);
    const x1 = al / 0.98;
    const be2 = Math.min(0.99, be / (1 - al));
    return [Math.log(om), Math.log(x1 / (1 - x1)), Math.log(be2 / (1 - be2))];
  });
  let best = null;
  for (const s of starts) {
    const res = nelderMead(negLL, s, { maxIter: 600 });
    if (!best || res.fx < best.fx) best = res;
  }
  const omega = Math.exp(best.x[0]);
  const alpha = 0.98 * sigmoid(best.x[1]);
  const beta = (1 - alpha) * sigmoid(best.x[2]);
  // дисперсия прогноза на следующий день
  let sig2 = var0;
  for (let t = 0; t < n; t++) sig2 = omega + alpha * r[t] * r[t] + beta * sig2;
  return { omega, alpha, beta, ll: -best.fx, sig2next: sig2, muRet: mu, n };
}

// E[σ²] на h дней вперёд: v_h = ω̄ + (α+β)^{h−1}(σ²_next − ω̄)
function garchForecast(fit, horizonDays) {
  const persist = fit.alpha + fit.beta;
  const longRun = fit.omega / Math.max(1e-12, 1 - persist);
  let acc = 0;
  for (let h = 1; h <= horizonDays; h++) acc += longRun + Math.pow(persist, h - 1) * (fit.sig2next - longRun);
  return {
    avgVar: acc / horizonDays,
    varAt: longRun + Math.pow(persist, horizonDays - 1) * (fit.sig2next - longRun),
    longRunVar: longRun,
  };
}

// ── Вероятность касания нижнего барьера за время T (GBM, принцип отражения) ──
// X(t) = νt + σW(t), ν = μ − σ²/2, b = ln(target/S0) < 0:
//   P(min X ≤ b) = Φ((b − νT)/(σ√T)) + e^{2νb/σ²}·Φ((b + νT)/(σ√T))
function pTouch(S0, target, muAnn, sigAnn, years) {
  if (target >= S0) return 1;
  const b = Math.log(target / S0);
  const nu = muAnn - sigAnn * sigAnn / 2;
  const sT = sigAnn * Math.sqrt(years);
  const p = normCdf((b - nu * years) / sT)
    + Math.exp((2 * nu * b) / (sigAnn * sigAnn)) * normCdf((b + nu * years) / sT);
  return Math.min(1, Math.max(0, p));
}

module.exports = { nelderMead, fitGARCH, garchForecast, pTouch };
