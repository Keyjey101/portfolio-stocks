// Линейная алгебра: СЛАУ (Гаусс), ридж-регрессия, собственные значения (Якоби).

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular matrix');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

function standardizeCols(X) {
  const n = X.length, k = X[0].length;
  const means = new Array(k).fill(0), vars = new Array(k).fill(0);
  for (const row of X) for (let j = 0; j < k; j++) means[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < k; j++) vars[j] += (row[j] - means[j]) ** 2 / (n - 1);
  const Z = X.map(row => row.map((v, j) => (vars[j] > 0 ? (v - means[j]) / Math.sqrt(vars[j]) : 0)));
  return { Z, means, sds: vars.map(v => Math.sqrt(v)) };
}

// X: n×k (уже стандартизован), y центрируется внутри; λ — ридж-коэффициент
function ridgeSolve(X, y, lambda) {
  const n = X.length, k = X[0].length;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const yc = y.map(v => v - my);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++) {
      Xty[j] += X[i][j] * yc[i];
      for (let m = j; m < k; m++) XtX[j][m] += X[i][j] * X[i][m];
    }
  for (let j = 0; j < k; j++) for (let m = 0; m < j; m++) XtX[j][m] = XtX[m][j];
  for (let j = 0; j < k; j++) XtX[j][j] += lambda;
  return solve(XtX, Xty);
}

// собственные значения симметричной матрицы, вращения Якоби, по убыванию
function jacobiEigen(A, maxSweeps = 100, tol = 1e-12) {
  const n = A.length;
  const a = A.map(r => [...r]);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let j = 0; j < n; j++) for (let m = j + 1; m < n; m++) off += a[j][m] ** 2;
    if (off < tol) break;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i][p], aiq = a[i][q];
          a[i][p] = c * aip - s * aiq;
          a[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p][i], aqi = a[q][i];
          a[p][i] = c * api - s * aqi;
          a[q][i] = s * api + c * aqi;
        }
      }
  }
  return a.map((r, i) => r[i]).sort((x, y) => y - x);
}

module.exports = { solve, standardizeCols, ridgeSolve, jacobiEigen };
