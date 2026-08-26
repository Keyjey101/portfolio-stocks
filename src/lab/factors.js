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

// ── #М6 Ортогонализация Грама-Шмидта ──
// SPH/XLK/SMH скоррелированы 0.8+: ридж размазывает нагрузку и даёт артефакты
// вида «SMH β = −0.25 у портфеля с 36% AI-ядра». Здесь каждый фактор —
// остаток от регрессии на ПРЕДЫДУЩИЕ (order: рынок первым), поэтому β к
// орто-SMH читается как «чувствительность сверх рыночной» — то, что нужно.
// Вырожденный случай: фактор почти полностью объяснён предыдущими (например,
// дублирует рынок) — остаток это флот-шум, обнуляем, чтобы стандартизация
// не раздувала бету до тысяч.
function orthogonalize(R, order) {
  const orth = {};
  const done = [];        // факторы базиса (не вырожденные)
  const varOf = a => {
    const m = mean(a);
    return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
  };
  for (const f of order) {
    if (!R[f]) continue;
    if (!done.length) { orth[f] = R[f]; done.push(f); continue; }
    const X = R[f].map((_, i) => done.map(g => orth[g][i]));
    const { Z, sds } = standardizeCols(X);
    // OLS без риджа: предыдущие орто-факторы взаимно ортогональны по
    // построению — мультиколлинеарности нет, усадка только вредила
    // (остаток «фактор ≈ рынок» раздувался до 1e-6·рынка)
    const b = ridgeSolve(Z, R[f], 0);
    const raw = done.map((g, j) => (sds[j] > 0 ? b[j] / sds[j] : 0));
    const res = R[f].map((v, i) => v - raw.reduce((s, c, j) => s + c * orth[done[j]][i], 0));
    if (varOf(res) < 1e-8 * varOf(R[f])) {
      orth[f] = R[f].map(() => 0); // фактор объяснён базисом — в базис не входит
    } else {
      orth[f] = res;
      done.push(f);
    }
  }
  return orth;
}

function analyzeFactorModel({ prices, positions, factors = FACTOR_PROXIES, market = 'SPY' }) {
  const tickers = positions.map(p => p.t);
  const R = {};
  for (const t of [...tickers, ...factors, market]) if (!R[t]) R[t] = logRet(prices[t]);
  const T = R[factors[0]].length;

  // #1: скользящие окна → ридж-беты (последнее окно + σβ по окнам).
  // Регрессия идёт по стандартизованным факторам, но беты переводятся
  // в сырые единицы (β на 1% фактора) делением на σ фактора окна.
  const betas = {};
  const r2 = {};
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
    const out = { beta: {}, sigma: {}, se: {}, ci: {} };
    factors.forEach((f, j) => {
      out.beta[f] = last[j];
      out.sigma[f] = sd(wins.map(w => w[j]));
      // se по разбросу оконских β (прокси; окна перекрываются — интервал
      // приблизительный, но лучше, чем бета без интервала вообще)
      out.se[f] = out.sigma[f] / Math.sqrt(Math.max(1, wins.length));
      out.ci[f] = [last[j] - 1.96 * out.se[f], last[j] + 1.96 * out.se[f]];
    });
    betas[t] = out;

    // R² последнего окна: доля дисперсии позиции, объяснённая факторной моделью
    const yW = R[t].slice(T - WINDOW);
    const my = mean(yW);
    let ssr = 0, sst = 0;
    for (let k = 0; k < WINDOW; k++) {
      const i = T - WINDOW + k;
      const yhat = factors.reduce((s, f, j) => s + last[j] * R[f][i], 0);
      ssr += (yW[k] - yhat) ** 2;
      sst += (yW[k] - my) ** 2;
    }
    r2[t] = sst > 0 ? Math.max(0, Math.min(1, 1 - ssr / sst)) : null;
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

  // ── #М6: беты к ортогонализованным факторам (Грам-Шмидт, рынок первым) ──
  // β(орто-SMH) — чувствительность СВЕРХ рыночной; из неё считается
  // эмпирическая AI-бета для движка мандата (#М4)
  const orthOrder = [market, ...factors.filter(f => f !== market)].filter(f => R[f]);
  const orth = orthogonalize(R, orthOrder);
  const orthBetas = {};
  for (const t of tickers) {
    const X = [], y = [];
    for (let i = T - WINDOW; i < T; i++) {
      X.push(orthOrder.map(f => orth[f][i]));
      y.push(R[t][i]);
    }
    const { Z, sds } = standardizeCols(X);
    const b = ridgeSolve(Z, y, LAMBDA_SCALE * WINDOW);
    orthBetas[t] = {};
    orthOrder.forEach((f, j) => { orthBetas[t][f] = sds[j] > 0 ? b[j] / sds[j] : 0; });
  }
  const orthExposure = {}, orthByTag = {};
  for (const f of orthOrder) orthExposure[f] = 0;
  for (const p of positions) {
    const w = totalVal > 0 ? p.val / totalVal : 0;
    for (const f of orthOrder) {
      orthExposure[f] += w * orthBetas[p.t][f];
      orthByTag[p.tag] = orthByTag[p.tag] || {};
      orthByTag[p.tag][f] = (orthByTag[p.tag][f] || 0) + w * orthBetas[p.t][f];
    }
  }
  // knee-проверка: у портфеля с AI-ядром β(орто-SMH) ядра не может быть
  // отрицательной — если осталась, в данных ошибка: логируем и не показываем
  let aiOrthSmh = orthByTag.core?.SMH ?? null;
  if (aiOrthSmh != null && aiOrthSmh < -0.05) {
    console.error(`factors: артефакт ортогонализации — AI-ядро β(орто-SMH)=${aiOrthSmh.toFixed(2)} < 0; проверь данные, эмпирическая AI-бета скрыта`);
    aiOrthSmh = null;
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
  // скачок корреляции имеет смысл, только если посчитаны оба режима
  const bothRegimes = regimes.stress.dr != null && regimes.normal.dr != null;
  const corrJump = bothRegimes
    ? tickers
        .map(t => ({ t, jump: (regimes.stress.corr[t] ?? 0) - (regimes.normal.corr[t] ?? 0) }))
        .sort((a, b) => b.jump - a.jump)
    : [];

  return {
    window: WINDOW, tickers, factors, betas, exposure, byTag,
    r2,
    orthOrder, orthBetas, orthExposure, orthByTag, aiOrthSmh,
    enb, eig,
    stress: { ...regimes.stress, rangeDays: T }, normal: { ...regimes.normal, rangeDays: T }, corrJump,
    generatedAt: new Date().toISOString(),
  };
}

// ── I/O: заливка цен Yahoo, выравнивание по датам, суточный кэш ──
const { chart, pool } = require('../yahoo');
const { positions: defaultPositions } = require('../portfolio');
const { readCache, writeCache } = require('../cache');

const DAY = 24 * 3600e3;

async function loadPrices(tickers, range = '1y') {
  const out = {};
  await pool(tickers, async t => {
    const d = await chart(t, range).catch(() => null);
    if (d && Array.isArray(d.closes) && d.closes.length > 120) out[t] = { closes: d.closes, ts: d.ts };
  });
  return out;
}

// пересечение КАЛЕНДАРНЫХ дней всех рядов → выровненные числовые ряды.
// (метки Yahoo у индексов плывут внутри дня: ^GSPC 13:30 UTC, ^VIX 07:00 —
// точное совпадение секунд между индексом и акцией почти всегда пусто)
function alignPrices(raw) {
  const keys = Object.keys(raw);
  if (!keys.length) return {};
  let common = null;
  for (const k of keys) {
    const set = new Set(raw[k].ts.filter(Boolean).map(t => Math.floor(t / 86400)));
    common = common ? new Set([...common].filter(d => set.has(d))) : set;
  }
  const sorted = [...common].sort((a, b) => a - b);
  const out = {};
  for (const k of keys) {
    const m = new Map();
    for (let i = 0; i < raw[k].ts.length; i++) {
      if (raw[k].ts[i] == null || raw[k].closes[i] == null) continue;
      m.set(Math.floor(raw[k].ts[i] / 86400), raw[k].closes[i]);
    }
    out[k] = sorted.map(d => m.get(d));
  }
  return out;
}

let inflight = null;

async function runFactors({ force = false, positionsLoader = defaultPositions, cacheName = 'factors' } = {}) {
  if (!force) {
    const cached = readCache(cacheName, DAY);
    if (cached) return { ...cached, cached: true };
    if (inflight) return inflight;
  }
  inflight = (async () => {
    const list = (await positionsLoader()).filter(p => p.qty > 0 || p.t === 'ITOT');
    const universe = [...new Set([...list.map(p => p.t), ...FACTOR_PROXIES])];
    // #М6: 3 года — чтобы стресс-корреляции при редких стрессах считались
    // по расширенному окну, а не отказывались (было: 1y и «меньше 10 дней»)
    const raw = await loadPrices(universe, '3y');
    const aligned = alignPrices(raw);
    const okList = list.filter(p => aligned[p.t] && aligned[p.t].length > WINDOW + 10);
    const model = okList.map(p => ({ t: p.t, tag: p.tag, val: (p.qty || 0) * aligned[p.t].at(-1) }));
    const res = analyzeFactorModel({ prices: aligned, positions: model });
    writeCache(cacheName, res);
    return { ...res, cached: false };
  })();
  try { return await inflight; } finally { inflight = null; }
}

module.exports = { FACTOR_PROXIES, WINDOW, STEP, STRESS_RET, analyzeFactorModel, orthogonalize, loadPrices, alignPrices, runFactors };
