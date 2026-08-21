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

module.exports = { nelderMead };
