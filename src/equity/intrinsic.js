// Детерминированный движок оценки (спека 03 — ядро системы).
// На вход: датасет data.js + financial_metrics; на выход — {base, bear, bull,
// epv, mos, score, methods[], …}. Никакого LLM внутри: нарратив пишется поверх
// готовых чисел и не имеет права их менять (канонический пересчёт MoS — ниже
// и в оркестраторе). Все строки-пояснения — сразу на русском (улучшение 10 §1).

const clamp = (x, lo, hi) => (x == null || !Number.isFinite(x) ? lo : Math.min(hi, Math.max(lo, x)));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => {
  if (!a || !a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const pos = a => a.filter(v => Number.isFinite(v) && v > 0);

const BANK_KEYWORDS = /bank|insurance|insurer|reinsurance|mortgage/i;
const CAP_HEAVY_SECTORS = new Set(['Financial Services', 'Real Estate', 'Utilities', 'Basic Materials']);

// ── 3.1 стоимость капитала ──
function costOfCapital(ds, fm, rf0) {
  const rf = clamp(rf0 != null ? rf0 / 100 : 0.043, 0.01, 0.08);
  const rawBeta = ds.meta?.beta;
  const beta = clamp(0.67 * clamp(rawBeta ?? 1, 0, 2.5) + 0.33, 0.70, 2.20);
  const erp = 0.055;
  const ke = clamp(rf + beta * erp, rf + 0.045, 0.22);

  const d = ds.derived;
  const debt0 = d.total_debt?.[0], int0 = d.interest_expense?.[0];
  let kd = (debt0 > 0 && int0 != null && int0 !== 0) ? Math.abs(int0) / debt0 : 0.06;
  kd = clamp(kd, 0.02, 0.15);

  // медианная эффективная ставка налога за ≤6 лет: 0 < NI < EBT
  const taxes = [];
  for (let i = 0; i < Math.min(6, d.year?.length || 0); i++) {
    const ni = d.net_income?.[i], oi = d.operating_income?.[i], ie = d.interest_expense?.[i];
    if (ni == null || oi == null || ie == null) continue;
    const ebt = oi - Math.abs(ie);
    if (ni > 0 && ni < ebt) taxes.push(1 - ni / ebt);
  }
  const tax = taxes.length ? clamp(median(taxes), 0.10, 0.35) : 0.21;

  const mc = ds.meta?.market_cap ?? 0;
  const ev = ds.meta?.enterprise_value;
  let D = (ev != null && mc > 0) ? Math.max(0, ev - mc) : (debt0 ?? 0);
  const V = mc + D || 1;
  const wacc = clamp(V > 0 ? (mc / V) * ke + (D / V) * kd * (1 - tax) : ke, rf + 0.025, 0.20);
  return { rf, beta, ke, kd, tax, wacc, D, V };
}

// ── 3.2 нормализованная прибыль (Greenwald) ──
function normalizeEarnings(ds, fm, tax = 0.21) {
  const d = ds.derived;
  const cyc = fm.is_cyclical;
  const win = cyc ? Math.min(10, d.year.length) : Math.min(3, d.year.length);

  // нормализуем МАРЖУ: медиана по окну, отношения вне [−1.0, 0.85] отбрасываются
  const normMargin = (margins, revenues) => {
    const ratios = [];
    for (let i = 0; i < win; i++) {
      const m = margins?.[i], r = revenues?.[i];
      if (m == null || !(r > 0)) continue;
      const ratio = m / r;
      if (ratio >= -1.0 && ratio <= 0.85) ratios.push(ratio);
    }
    return ratios.length ? median(ratios) : null;
  };
  const mEbit = normMargin(d.operating_income, d.revenue);
  const mEbitda = normMargin(d.ebitda, d.revenue);
  const revNow = d.revenue?.[0] ?? null;
  const revCyc = cyc ? median(pos((d.revenue || []).slice(0, win))) : revNow;

  let norm_ebit = mEbit != null && revNow != null ? mEbit * (cyc ? revCyc : revNow) : null;
  let norm_ebitda = mEbitda != null && revNow != null ? mEbitda * (cyc ? revCyc : revNow) : null;

  // абсолютный фоллбек: медиана долларов (цикличная) / среднее 4 лет (стабильная)
  if (norm_ebit == null) {
    const vals = d.operating_income?.slice(0, cyc ? win : 4).filter(v => Number.isFinite(v)) || [];
    norm_ebit = cyc ? (pos(vals).length ? median(pos(vals)) : null) : (vals.length ? mean(vals) : null);
  }
  if (norm_ebitda == null) {
    const vals = d.ebitda?.slice(0, cyc ? win : 4).filter(v => Number.isFinite(v)) || [];
    norm_ebitda = cyc ? (pos(vals).length ? median(pos(vals)) : null) : (vals.length ? mean(vals) : null);
  }

  const is_cyclically_adjusted = cyc && (revCyc != null && revCyc !== revNow);

  // базовый FCFF: медиана FCF (8 лет цикличная / 4 стабильная, положительные)
  const fcfWin = cyc ? 8 : 4;
  const fcfSeries = pos((d.free_cash_flow || []).slice(0, fcfWin));
  let fcff0 = fcfSeries.length ? median(fcfSeries) : null;
  let fcf_proxied = false;
  if (fcff0 == null) {
    // прокси из нормализованной NI
    const ni = norm_ebit != null ? norm_ebit * 0.78 : d.net_income?.[0]; // EBT≈EBIT−проценты, без точного налога здесь
    if (ni != null && ni > 0) { fcff0 = ni; fcf_proxied = true; }
  }
  const int0 = Math.abs(d.interest_expense?.[0] ?? 0);
  if (fcff0 != null) fcff0 += int0 * (1 - tax);

  // нормализованный капекс: ряды капекса обычно отрицательные — берём модули
  const capexAbs = (d.capex || []).slice(0, fcfWin)
    .map(v => Math.abs(v)).filter(v => Number.isFinite(v) && v > 0);
  const norm_capex = capexAbs.length ? median(capexAbs) : Math.abs(d.capex?.[0] ?? 0);

  return { norm_ebit, norm_ebitda, fcff0, fcf_proxied, norm_capex, is_cyclically_adjusted };
}

// ── 3.3 центральный рост g ──
function centralGrowth(ds, fm) {
  const revG = [fm.revenue_cagr_3y, fm.revenue_cagr_5y].filter(v => v != null);
  const rev_g = revG.length ? median(revG) : null;
  const margin_allow = fm.margin_trend === 'declining' ? 0 : 0.03;
  const g_cap = rev_g != null ? rev_g + margin_allow : 0.12;
  const cand = [];
  for (const c of [fm.eps_cagr_5y, fm.eps_cagr_3y, ds.analyst?.eps_growth_next_year]) {
    if (c != null && Number.isFinite(c)) cand.push(Math.min(c, g_cap));
  }
  if (rev_g != null) cand.push(rev_g);
  let g = cand.length ? median(cand) : 0.03;
  if (fm.revenue_trend === 'declining') g = Math.min(g, Math.max(rev_g ?? 0, -0.08));
  return clamp(g, -0.10, 0.40);
}

function dcfHorizon(fm, g, roic) {
  if (fm.is_cyclical) return 5;
  if (roic >= 0.12 && g >= 0.12) return 10;
  if (g >= 0.08) return 7;
  return 5;
}

// ── 3.4 методы (каждый → стоимость на акцию) ──
function computeMethods(ds, fm, ctx) {
  const { wacc, ke, tax, rf } = ctx.cc;
  const g = ctx.g;
  const d = ds.derived;
  const shares = ds.meta?.shares_outstanding || (ds.meta?.market_cap && ds.meta?.current_price ? ds.meta?.market_cap / ds.meta?.current_price : null);
  const price = ds.meta?.current_price;
  if (!shares || !price) return { methods: [], shares, roicUsed: null };

  const netDebt = d.net_debt?.[0] ?? ((d.total_debt?.[0] ?? 0) - (d.cash?.[0] ?? 0));
  const norm = ctx.norm;
  const industry = String(ds.meta?.industry || '');
  const sector = String(ds.meta?.sector || '');
  const isBank = BANK_KEYWORDS.test(industry);

  const g_t = Math.min(0.025, rf, wacc - 0.03, Math.max(0, g));
  const methods = [];
  const ok = (name, value, weight) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return;
    methods.push({ name, value: +value.toFixed(2), weight });
  };

  // ROIC: max(GAAP, cash); нормализация asset-light
  const invested = (d.total_debt?.[0] ?? 0) + Math.max(0, d.total_equity?.[0] ?? 0) - (d.cash?.[0] ?? 0);
  const gaapRoic = invested > 0 && d.net_income?.[0] != null ? d.net_income[0] / invested : (fm.avg_roic ?? null);
  const cashRoic = norm.norm_ebitda != null && Number.isFinite(norm.norm_capex)
    ? Math.max(0, norm.norm_ebitda - norm.norm_capex) * (1 - tax) / Math.max(invested, 1e-9)
    : null;
  let roicUsed = Math.max(...[gaapRoic, cashRoic].filter(v => v != null && Number.isFinite(v)).map(v => Math.max(0, v)), 0);
  let roic_normalized = false, asset_light = false;
  const ebitdaMargin = norm.norm_ebitda != null && d.revenue?.[0] > 0 ? norm.norm_ebitda / d.revenue[0] : 0;
  if ((gaapRoic ?? 1) < 0.08 && ebitdaMargin > 0.18 && (norm.fcff0 ?? 0) > 0) {
    roicUsed = 0.15; roic_normalized = true;
  }
  if ((roicUsed >= 0.22 && !fm.is_cyclical && !isBank) || roic_normalized) asset_light = true;
  roicUsed = clamp(roicUsed, 0.04, 0.60);

  const horizon = dcfHorizon(fm, g, roicUsed);
  const nopat0 = Math.max(
    (norm.norm_ebit ?? 0) * (1 - tax),
    norm.norm_ebitda != null ? (norm.norm_ebitda - norm.norm_capex) * (1 - tax) : 0,
  );

  // 1. DCF value-driver: FCFF_t = NOPAT_t·(1 − g_t/ROIC), рост линейно гасится
  const rr = g => Math.max(0, Math.min(0.95, roicUsed > 0 ? g / roicUsed : 0.95));
  const dcfValueDriver = (gg, waccArg) => {
    if (waccArg - g_t < 0.03) return null;
    let pv = 0, nopat = nopat0;
    for (let t = 1; t <= horizon; t++) {
      const gLin = gg + (g_t - gg) * (t / horizon); // линейное затухание g → g_t
      nopat = t === 1 ? nopat0 * (1 + gLin) : nopat * (1 + gLin);
      const fcff = nopat * (1 - Math.min(0.95, Math.max(0, g_t / roicUsed)));
      pv += fcff / Math.pow(1 + waccArg, t);
    }
    const termNopat = nopat * (1 + g_t);
    const term = termNopat * (1 - rr(g_t)) / (waccArg - g_t);
    const ev = pv + term / Math.pow(1 + waccArg, horizon);
    return (ev - netDebt) / shares;
  };
  ok('dcf', dcfValueDriver(g, wacc), 'w_dcf');

  // 2. простой двухстадийный FCFF DCF (фолбэк)
  const fcff0 = norm.fcff0;
  if (fcff0 != null && fcff0 > 0 && wacc - g_t >= 0.03) {
    let pv = 0, f = fcff0;
    for (let t = 1; t <= horizon; t++) {
      const gLin = g + (g_t - g) * (t / horizon);
      f *= (1 + gLin);
      pv += f / Math.pow(1 + wacc, t);
    }
    const term = f * (1 + g_t) / (wacc - g_t);
    ok('dcf_fcff', (pv + term / Math.pow(1 + wacc, horizon) - netDebt) / shares, 'w_dcf2');
  }

  // 3. EPV (Greenwald)
  if (norm.norm_ebit != null && wacc > 0) {
    ok('epv', (norm.norm_ebit * (1 - tax) / wacc - netDebt) / shares, 'w_epv');
  }

  // 4. обоснованный P/E
  const epsF = ds.eps_data?.forward_eps ?? ds.eps_data?.trailing_eps;
  if (epsF != null && epsF > 0) {
    const g_pe = Math.min(g, 0.06);
    const retention = roicUsed > 0 ? Math.min(0.90, g_pe / roicUsed) : 0.5;
    const pe = clamp((1 - retention) * (1 + g_pe) / Math.max(ke - g_pe, 0.03), 6, 30);
    ok('pe', pe * epsF, 'w_pe');
  }

  // 5. обоснованный EV/EBITDA
  if (norm.norm_ebitda != null && norm.norm_ebitda > 0) {
    const mult = clamp(8 + 50 * g, 6, 22);
    ok('ev_ebitda', (mult * norm.norm_ebitda - netDebt) / shares, 'w_evebitda');
  }

  // 6. Грэм: sqrt(22.5 · eps_norm · bvps), eps_norm капится на 1.5×trailing
  const bvps = d.total_equity?.[0] != null && d.total_equity[0] > 0 ? d.total_equity[0] / shares : null;
  if (bvps != null) {
    const niSeries = (d.net_income || []).slice(0, 5).filter(v => Number.isFinite(v) && v > 0);
    let epsNorm = niSeries.length ? mean(niSeries) / shares : null;
    if (epsNorm != null && ds.eps_data?.trailing_eps > 0) epsNorm = Math.min(epsNorm, 1.5 * ds.eps_data.trailing_eps);
    if (epsNorm != null && epsNorm > 0) ok('graham', Math.sqrt(22.5 * epsNorm * bvps), 'w_graham');
  }

  // 7. обоснованный P/B — только банки/страховщики
  if (isBank && bvps != null) {
    const roe = fm.avg_roe ?? 0.10;
    const g_s = Math.min(g, 0.03);
    const pbv = clamp((roe - g_s) / Math.max(ke - g_s, 0.04), 0.4, 2.5);
    ok('pb', pbv * bvps, 'w_pb');
  }

  // 8. аналитики: цель, дисконтированная на ke
  if (ds.analyst?.target_mean > 0) {
    ok('analyst', ds.analyst.target_mean / (1 + ke), 'w_analyst');
  }

  return { methods, shares, roicUsed, roic_normalized, asset_light, g_t, horizon, nopat0 };
}

// ── 3.5 веса по профилю ──
function weightsFor(ds, fm, flags) {
  const sector = String(ds.meta?.sector || '');
  const industry = String(ds.meta?.industry || '');
  if (BANK_KEYWORDS.test(industry)) {
    return { dcf: 0, epv: 0, pe: 0.25, ev_ebitda: 0, graham: 0.15, analyst: 0.15, pb: 0.45, dcf2: 0 };
  }
  if (flags.asset_light) {
    return { dcf: 0.42, epv: 0, pe: 0.34, ev_ebitda: 0.14, graham: 0, analyst: 0.10, pb: 0, dcf2: 0 };
  }
  if (CAP_HEAVY_SECTORS.has(sector)) {
    return { dcf: 0.22, epv: 0.20, pe: 0.15, ev_ebitda: 0.13, graham: 0.20, analyst: 0.10, pb: 0, dcf2: 0 };
  }
  return { dcf: 0.30, epv: 0.15, pe: 0.22, ev_ebitda: 0.15, graham: 0.08, analyst: 0.10, pb: 0, dcf2: 0 };
}

const WEIGHT_KEY = { dcf: 'dcf', dcf_fcff: 'dcf2', epv: 'epv', pe: 'pe', ev_ebitda: 'ev_ebitda', graham: 'graham', pb: 'pb', analyst: 'analyst' };

// ── 3.6 робастная агрегация: якорь = взвешенная медиана going-concern ──
function robustAggregate(methods, weights) {
  const withW = methods
    .map(m => ({ ...m, w: weights[WEIGHT_KEY[m.name]] ?? 0 }))
    .filter(m => m.w > 0);
  if (!withW.length) return { base: null, sigma: null };

  const anchorSet = withW.filter(m => ['dcf', 'pe', 'ev_ebitda', 'analyst', 'pb'].includes(m.name));
  let anchor;
  if (anchorSet.length) {
    const pairs = anchorSet.map(m => [m.value, m.w]).sort((a, b) => a[0] - b[0]);
    const wTot = pairs.reduce((s, p) => s + p[1], 0);
    let acc = 0;
    anchor = (pairs.find(([v, w]) => { acc += w; return acc >= wTot / 2; }) || pairs[pairs.length - 1])[0];
  } else {
    anchor = median(withW.map(m => m.value));
  }

  let num = 0, den = 0;
  for (const m of withW) {
    const ratio = m.value / anchor;
    const eff = ratio <= 2.0 && ratio >= 0.5 ? m.w : m.w * Math.pow(2.0 / Math.max(ratio, 1 / ratio), 1.0);
    num += m.value * eff; den += eff;
  }
  const base = den > 0 ? num / den : null;
  const logs = withW.map(m => Math.log(m.value));
  const mu = mean(logs);
  const sigma = Math.sqrt(mean(logs.map(x => (x - mu) ** 2)));
  return { base, sigma, anchor };
}

// ── полный пересчёт блэнда на сдвинутых драйверах (для bear/bull, §3.7) ──
function blendOnDrivers(ds, fm, ctx, { dg = 0, dw = 0, dm = 0 } = {}) {
  const cc2 = { ...ctx.cc };
  cc2.wacc = clamp(cc2.wacc + dw, 0.03, 0.30);
  cc2.ke = clamp(cc2.ke + dw, 0.03, 0.30);
  const ctx2 = {
    ...ctx, cc: cc2,
    g: clamp(ctx.g + dg, -0.15, 0.45),
    norm: { ...ctx.norm },
  };
  if (dm && ctx.norm.norm_ebit != null) ctx2.norm.norm_ebit *= (1 - dm);
  if (dm && ctx.norm.norm_ebitda != null) ctx2.norm.norm_ebitda *= (1 - dm);
  const { methods } = computeMethods(ds, fm, ctx2);
  const weights = weightsFor(ds, fm, ctx.flags);
  return robustAggregate(methods, weights).base;
}

// ── MoS-скор (§3.9) ──
function marginOfSafetyScore(mos) {
  if (mos == null) return 5;
  if (mos > 30) return 9;
  if (mos > 15) return 7;
  if (mos > -10) return 5;
  if (mos > -25) return 3;
  return 1;
}

// ── главный вход ──
function compute(ds, fm, { rf = null } = {}) {
  const price = ds.meta?.current_price ?? 100;
  const cc = costOfCapital(ds, fm, rf);
  const norm = normalizeEarnings(ds, fm, cc.tax);
  const g = centralGrowth(ds, fm);

  // проба стабильности DCF (§3.5): [g, g±0.05, консенсус]
  const { methods: mProbe, shares, roicUsed, roic_normalized, asset_light, g_t, horizon, nopat0 } =
    computeMethods(ds, fm, { cc, g, norm });
  const flags = { roic_normalized, asset_light };
  let weights = weightsFor(ds, fm, flags);

  const dcfVal = mProbe.find(m => m.name === 'dcf');
  if (dcfVal && ds.analyst?.eps_growth_next_year != null) {
    const variants = [
      dcfVal.value,
      blendOnDrivers(ds, fm, { cc, g, norm, flags }, { dg: +0.05, dw: 0, dm: 0 }),
      blendOnDrivers(ds, fm, { cc, g, norm, flags }, { dg: -0.05, dw: 0, dm: 0 }),
      blendOnDrivers(ds, fm, { cc, g, norm, flags }, { dg: clamp(ds.analyst.eps_growth_next_year, -0.1, 0.4) - g, dw: 0, dm: 0 }),
    ].filter(v => v != null && v > 0);
    if (variants.length >= 2) {
      const range = Math.max(...variants) / Math.min(...variants);
      if (range > 2.0) weights = { ...weights, dcf: weights.dcf * Math.max(0.1, 2.0 / range) };
    }
  }

  const agg = robustAggregate(mProbe, weights);
  let base = agg.base;
  const methods = mProbe.map(m => ({
    name: m.name, value: m.value,
    weight: +((weights[WEIGHT_KEY[m.name]] ?? 0)).toFixed(2),
  }));

  // сценарии bear/bull (§3.7)
  const beta = cc.beta;
  const dm = clamp(0.06 + 0.05 * beta, 0.06, 0.20);
  const dw = clamp(0.005 + 0.006 * beta, 0.005, 0.020);
  const dg = clamp(0.02 + 0.02 * beta + (fm.is_cyclical ? 0.015 : 0), 0.02, 0.08);
  const bearDrv = blendOnDrivers(ds, fm, { cc, g, norm, flags }, { dg: -dg, dw: +dw, dm: +dm });
  const bullDrv = blendOnDrivers(ds, fm, { cc, g, norm, flags }, { dg: +dg, dw: -dw, dm: -dm });
  const sigmaDriver = bearDrv > 0 && bullDrv > 0 ? Math.abs(Math.log(bullDrv / bearDrv)) / 2 : 0.3;
  const sigmaDisp = Math.min(0.50, agg.sigma ?? 0.25);
  const sigmaTotal = clamp(Math.sqrt(sigmaDriver ** 2 + sigmaDisp ** 2), 0.08, 0.60);

  // санити и гейты (§3.8)
  let data_quality = 'ok';
  const valuation_flags = [];
  if (base == null) {
    base = price || 100;
    data_quality = 'insufficient_data';
    valuation_flags.push('no_methods');
  }
  let clamped = false;
  if (data_quality === 'ok' && (base < 0.20 * price || base > 5.0 * price)) {
    base = clamp(base, 0.20 * price, 5.0 * price);
    data_quality = 'clamped_vs_price';
    clamped = true;
  }

  const coreVals = mProbe.filter(m => ['dcf', 'pe', 'ev_ebitda', 'pb'].includes(m.name)).map(m => m.value);
  const method_spread_ratio = coreVals.length >= 2 ? Math.max(...coreVals) / Math.min(...coreVals) : null;
  const high_dispersion = (sigmaDisp > 0.35) || (method_spread_ratio != null && method_spread_ratio > 2.5);
  if (high_dispersion) valuation_flags.push('high_method_dispersion');
  const low_reliability = method_spread_ratio != null && method_spread_ratio > 2.5;
  if (low_reliability) valuation_flags.push('low_reliability');

  const bear = base * Math.exp(-1.0 * sigmaTotal);
  const bull = base * Math.exp(+1.0 * sigmaTotal);
  const expected_value = 0.25 * bear + 0.50 * base + 0.25 * bull;

  const analystTarget = ds.analyst?.target_mean ?? null;
  const fv_target_gap = analystTarget != null && price > 0 ? Math.abs(base - analystTarget) / price : null;

  let no_estimate = (method_spread_ratio != null && method_spread_ratio > 3.0) || clamped
    || (fv_target_gap != null && fv_target_gap > 1.0) || fm.is_highly_cyclical;
  if (no_estimate) valuation_flags.push('no_estimate');
  if (fm.is_highly_cyclical) valuation_flags.push('cyclical_range_only');

  // округляем base до расчёта диапазона: свойство «цикличный диапазон ≥
  // [0.6·base, 1.6·base]» должно выполняться и на выводимых числах
  base = +base.toFixed(2);

  // диапазон показа
  const allVals = [bear, bull, ...mProbe.map(m => m.value)].filter(v => v > 0);
  let range_low = Math.min(...allVals), range_high = Math.max(...allVals);
  if (fm.is_highly_cyclical) {
    // расширение округляем НАРУЖУ, чтобы свойство [0.6·base, 1.6·base] держалось на выводимых числах
    range_low = Math.min(range_low, Math.floor(0.6 * base * 100) / 100);
    range_high = Math.max(range_high, Math.ceil(1.6 * base * 100) / 100);
  }

  // «поддержано против заложено в цену» (G1)
  const isBank = BANK_KEYWORDS.test(String(ds.meta?.industry || ''));
  const epvMethod = mProbe.find(m => m.name === 'epv');
  const grahamMethod = mProbe.find(m => m.name === 'graham');
  const supported_value = isBank
    ? (ds.derived.total_equity?.[0] != null && shares ? ds.derived.total_equity[0] / shares : (grahamMethod?.value ?? null))
    : (epvMethod?.value ?? (grahamMethod?.value ?? null));
  const priced_in = supported_value != null ? Math.round((price - supported_value) * 100) / 100 : null;

  let framing;
  if (supported_value == null) framing = 'Данных для оценки «поддержанной стоимости» недостаточно.';
  else if (fm.is_highly_cyclical) {
    framing = `Цикличная компания: отчётность поддерживает ≈ $${supported_value.toFixed(2)}/акцию без роста; ` +
      `в цене заложено $${(price - supported_value).toFixed(2)} ожиданий цикла — оценка дана диапазоном, а не точкой.`;
  } else if (price > supported_value * 1.15) {
    framing = `Текущая отчётность поддерживает ≈ $${supported_value.toFixed(2)}/акцию без роста; ` +
      `в цене заложено $${(price - supported_value).toFixed(2)} будущих денежных потоков — вы платите за рост.`;
  } else {
    framing = `Отчётность уже поддерживает ≈ $${supported_value.toFixed(2)}/акцию; цена $${price.toFixed(2)} ` +
      `не требует от будущего ничего экстраординарного.`;
  }

  const mos = base != null && price > 0 ? Math.round(((base - price) / price) * 1000) / 10 : null;
  const score = marginOfSafetyScore(mos);

  const assumptions = `g=${(g * 100).toFixed(1)}% · WACC=${(cc.wacc * 100).toFixed(1)}% · ke=${(cc.ke * 100).toFixed(1)}% · ` +
    `g_t=${g_t != null ? (g_t * 100).toFixed(1) + '%' : '?'} · горизонт=${horizon} лет · ROIC=${(roicUsed * 100).toFixed(1)}%` +
    (norm.is_cyclically_adjusted ? ' · циклически нормализовано' : '') + (norm.fcf_proxied ? ' · FCFF проксирован прибылью' : '');

  return {
    base: +base.toFixed(2), bear: +bear.toFixed(2), bull: +bull.toFixed(2),
    expected_value: +expected_value.toFixed(2),
    probabilities: { bear: 0.25, base: 0.50, bull: 0.25 },
    epv: epvMethod ? epvMethod.value : null,
    mos, score,
    methods,
    analyst_target: analystTarget,
    analyst_target_pv: analystTarget != null ? +(analystTarget / (1 + cc.ke)).toFixed(2) : null,
    wacc: +cc.wacc.toFixed(4), ke: +cc.ke.toFixed(4),
    growth: +g.toFixed(4), terminal_growth: g_t != null ? +g_t.toFixed(4) : null,
    dispersion: +sigmaTotal.toFixed(3),
    dispersion_flag: high_dispersion,
    method_spread_ratio: method_spread_ratio != null ? +method_spread_ratio.toFixed(2) : null,
    low_reliability, asset_light, no_estimate,
    range_low: +range_low.toFixed(2), range_high: +range_high.toFixed(2),
    fv_target_gap: fv_target_gap != null ? +fv_target_gap.toFixed(2) : null,
    supported_value: supported_value != null ? +supported_value.toFixed(2) : null,
    priced_in,
    framing,
    valuation_flags,
    assumptions,
    data_quality,
    is_cyclically_adjusted: norm.is_cyclically_adjusted,
    roic_used: +roicUsed.toFixed(3),
    roic_normalized,
    price,
    // legacy-имена для фронтенда (§3.10)
    dcf_base: +base.toFixed(2), dcf_bear: +bear.toFixed(2), dcf_bull: +bull.toFixed(2),
    cost_of_equity: +cc.ke.toFixed(4), growth_used: +g.toFixed(4),
    valuation_floor: supported_value, earnings_power_value: epvMethod ? epvMethod.value : null,
    margin_of_safety_pct: mos, valuation_score: score,
  };
}

module.exports = {
  compute, costOfCapital, normalizeEarnings, centralGrowth, computeMethods,
  weightsFor, robustAggregate, marginOfSafetyScore, blendOnDrivers,
};
