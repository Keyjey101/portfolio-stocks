// financial-агент (спека 03 §3.11): чистая математика по годовому датасету —
// CAGR'ы, тренды, средние, скоры 0–10, цикличность, упрощённый Piotroski,
// eps_quality_flag, accruals. Без LLM и без сети: детерминизм важнее блеска.

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const median = a => {
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// CAGR по ряду (свежие первыми): берём последние n лет, сравниваем свежей
// с самой старой точкой; нужны обе концы и положительная база
function cagr(series, n) {
  const vals = (series || []).filter(v => Number.isFinite(v)).slice(0, n);
  if (vals.length < 2) return null;
  const newest = vals[0], oldest = vals[vals.length - 1];
  if (!(oldest > 0) || !Number.isFinite(newest)) return null;
  return Math.pow(newest / oldest, 1 / (vals.length - 1)) - 1;
}

// тренд: свежий темп роста против старого (свежие первыми). Уровень падает
// быстрее 5%/год — «declining» независимо от старого темпа; ускорение роста —
// «improving»; прочее стабильное движение — «stable».
function trend(series) {
  const vals = (series || []).filter(v => Number.isFinite(v)).slice(0, 4);
  if (vals.length < 2) return 'unknown';
  const yoy = i => (vals[i + 1] > 0 ? vals[i] / vals[i + 1] - 1 : null);
  const g0 = yoy(0);
  if (g0 == null) return 'unknown';
  if (g0 < -0.05) return 'declining';
  const g1 = vals.length >= 4 ? yoy(2) : (vals.length === 3 ? yoy(1) : null);
  if (g1 != null && g0 > g1 + 0.02) return 'improving';
  if (g1 == null && g0 > 0.05) return 'improving';
  return 'stable';
}

// σ маржи (доля, не %): для детекта цикличности
function stdDev(arr) {
  const vals = (arr || []).filter(v => Number.isFinite(v));
  if (vals.length < 2) return 0;
  const m = mean(vals);
  return Math.sqrt(mean(vals.map(v => (v - m) ** 2)));
}

// просадка выручки от максимума ряда (доля)
function maxDrawdown(series) {
  const vals = (series || []).filter(v => Number.isFinite(v)).slice().reverse(); // старые → новые
  let peak = -Infinity, dd = 0;
  for (const v of vals) {
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

// ── скоры 0–10 (лестницы спеки §3.11) ──
function growthScore(cagr3, revTrend) {
  let s;
  const g = cagr3;
  if (g == null) s = 5;
  else if (g >= 0.15) s = 9.5;
  else if (g >= 0.10) s = 8.0;
  else if (g >= 0.05) s = 6.5;
  else if (g >= 0.02) s = 5.0;
  else if (g >= 0) s = 3.5;
  else s = 1.5;
  if (revTrend === 'improving') s += 1.5;
  if (revTrend === 'declining') s -= 0.5;
  return clamp(s, 0, 10);
}

function profitabilityScore(avgOpMargin) {
  if (avgOpMargin == null) return 5;
  if (avgOpMargin >= 0.25) return 9.5;
  if (avgOpMargin >= 0.15) return 8.0;
  if (avgOpMargin >= 0.08) return 6.5;
  if (avgOpMargin >= 0.03) return 4.5;
  if (avgOpMargin >= 0) return 3.0;
  return 1.0;
}

function efficiencyScore(avgRoic) {
  if (avgRoic == null) return 5;
  if (avgRoic >= 0.20) return 9.5;
  if (avgRoic >= 0.15) return 8.0;
  if (avgRoic >= 0.10) return 6.5;
  if (avgRoic >= 0.05) return 4.5;
  return 2.5;
}

function cashflowScore({ fcfPosShare, fcfConv, debtEbitda, currentDebtRatio, interestCoverage }) {
  let s;
  if (fcfPosShare == null) s = 5;
  else if (fcfPosShare >= 0.85) s = 9.0;
  else if (fcfPosShare >= 0.65) s = 7.5;
  else if (fcfPosShare >= 0.45) s = 6.0;
  else if (fcfPosShare >= 0.25) s = 4.0;
  else s = 2.0;
  if (fcfConv != null && fcfConv >= 0.8) s += 1;
  if (debtEbitda != null && debtEbitda > 4) s -= 1.5;
  if (currentDebtRatio != null && currentDebtRatio > 0.3) s -= 1;
  if (interestCoverage != null && interestCoverage < 2) s -= 1.5;
  return clamp(s, 0, 10);
}

// цикличность: сектор + подтверждение данными (σ маржи ≥ 6 п.п. или просадка
// выручки ≥ 20%); структурные кейворды обходят вето «нецикличный сектор»
const CYCLICAL_SECTORS = new Set(['Energy', 'Basic Materials', 'Industrials', 'Consumer Cyclical', 'Real Estate']);
const HIGHLY_CYCLICAL_SECTORS = new Set(['Energy', 'Basic Materials', 'Real Estate']);
const STRUCT_KEYWORDS = /shipping|commodity|semiconductor|steel|oil|gas|marine|shipping/i;

function cyclicality({ sector, industry, marginStd, revDrawdown }) {
  const kw = STRUCT_KEYWORDS.test(String(industry || '') + ' ' + String(sector || ''));
  let base = CYCLICAL_SECTORS.has(sector) || kw;
  const confirmed = (marginStd != null && marginStd >= 0.06) || (revDrawdown != null && revDrawdown <= -0.20);
  const isCyclical = confirmed || (base && marginStd != null ? marginStd >= 0.03 : base);
  let highly = HIGHLY_CYCLICAL_SECTORS.has(sector) || kw;
  if (confirmed && marginStd >= 0.08) highly = true;
  if (highly && !isCyclical) return { is_cyclical: true, is_highly_cyclical: true };
  return { is_cyclical: !!isCyclical, is_highly_cyclical: !!highly };
}

// упрощённый Piotroski F (макс. 7; +1 за низкие accruals добавляется снаружи)
function piotroski(d) {
  let f = 0;
  const ni = d.net_income || [], ocf = d.operating_cf || [];
  if (ni[0] > 0) f++;                                  // ROA > 0
  if (ocf[0] != null && ocf[0] > 0) f++;               // CFO > 0
  if (ni.length >= 2 && ni[1] != null && ni[0] > ni[1]) f++;  // рост NI
  const roic = d.roic || [];
  if (roic.length >= 2 && roic[1] != null && roic[0] > roic[1]) f++; // рост ROIC ( прокси ΔROA)
  const debt = d.total_debt || [];
  if (debt.length >= 2 && debt[1] != null && (debt[0] ?? 0) <= (debt[1] ?? 0)) f++; // долг не растёт
  const gm = d.gross_margin || [];
  if (gm.length >= 2 && gm[1] != null && (gm[0] ?? -1) > gm[1]) f++;  // маржа растёт
  const rev = d.revenue || [];
  if (rev.length >= 2 && rev[1] > 0 && rev[0] > rev[1]) f++;          // оборачиваемость растёт
  return f;
}

// eps_quality_flag: расхождение forward/trailing P/E (спека §3.11)
function epsQualityFlag(peTrailing, peForward) {
  if (!(peTrailing > 0) || !(peForward > 0)) return 'normal';
  const divergence = (peForward - peTrailing) / peTrailing;
  if (divergence > 0.5) return 'suspicious_trailing_pe';
  if (divergence > 0.3) return 'likely_one_time_gain';
  if (divergence < -0.15) return 'expected_growth';
  return 'normal';
}

// ── главный вход: dataset (из data.js fetchFull) → financial_metrics ──
function computeMetrics(ds) {
  const d = ds.derived || {};
  const avgN = (arr, n = 5) => {
    const vals = (arr || []).filter(v => Number.isFinite(v)).slice(0, n);
    return vals.length ? mean(vals) : null;
  };

  const revenue_cagr_3y = cagr(d.revenue, 3);
  const revenue_cagr_5y = cagr(d.revenue, 5);
  const eps_cagr_3y = cagr(d.eps, 3);
  const eps_cagr_5y = cagr(d.eps, 5);
  const revenue_trend = trend(d.revenue);
  const margin_trend = trend(d.operating_margin);

  const avg_operating_margin = avgN(d.operating_margin);
  const avg_gross_margin = avgN(d.gross_margin);
  const avg_roic = avgN(d.roic);
  const avg_roe = avgN(d.roe);
  const avg_debt_ebitda = avgN(d.debt_ebitda);
  const avg_interest_coverage = avgN(d.interest_coverage);

  const fcfVals = (d.free_cash_flow || []).filter(v => Number.isFinite(v));
  const fcf_positive_years = fcfVals.filter(v => v > 0).length;
  const fcf_available_years = fcfVals.length;
  const fcfPosShare = fcf_available_years ? fcf_positive_years / fcf_available_years : null;

  const marginStd = stdDev(d.operating_margin);
  const revDrawdown = maxDrawdown(d.revenue);
  const cyc = cyclicality({ sector: ds.meta?.sector, industry: ds.meta?.industry, marginStd, revDrawdown });

  const gScore = growthScore(revenue_cagr_3y, revenue_trend);
  const pScore = profitabilityScore(avg_operating_margin);
  const eScore = efficiencyScore(avg_roic);
  // current_debt_ratio: краткосрочный долг / весь долг (прокси из баланса)
  const currentDebtRatio = null; // в годовом ряду нет разбивки — не штрафуем
  const cScore = cashflowScore({
    fcfPosShare,
    fcfConv: d.fcf_conversion?.[0] ?? null,
    debtEbitda: avg_debt_ebitda,
    currentDebtRatio,
    interestCoverage: avg_interest_coverage,
  });
  const financial_strength_score = 0.25 * gScore + 0.30 * pScore + 0.25 * eScore + 0.20 * cScore;

  let pio = piotroski(d);
  const assets0 = d.total_assets?.[0];
  const ni0 = d.net_income?.[0], ocf0 = d.operating_cf?.[0];
  const accruals_ratio = assets0 > 0 && ni0 != null && ocf0 != null ? (ni0 - ocf0) / assets0 : null;
  if (accruals_ratio != null && accruals_ratio < 0.05) pio += 1; // accruals-бонус

  const debt_stress_flag = (avg_debt_ebitda != null && avg_debt_ebitda > 4)
    || (avg_interest_coverage != null && avg_interest_coverage < 2);

  const eps_flag = epsQualityFlag(ds.multiples?.pe_trailing, ds.multiples?.pe_forward);

  return {
    revenue_cagr_3y, revenue_cagr_5y, eps_cagr_3y, eps_cagr_5y,
    revenue_trend, margin_trend, eps_trend: trend(d.eps),
    avg_gross_margin, avg_operating_margin, avg_roic, avg_roe,
    avg_debt_ebitda, avg_interest_coverage,
    fcf_positive_years, fcf_available_years,
    margin_volatility: marginStd, revenue_drawdown: revDrawdown,
    is_cyclical: cyc.is_cyclical, is_highly_cyclical: cyc.is_highly_cyclical,
    cyclicality_tag: cyc.is_highly_cyclical ? 'highly_cyclical' : (cyc.is_cyclical ? 'cyclical' : null),
    growth_score: +gScore.toFixed(1), profitability_score: +pScore.toFixed(1),
    efficiency_score: +eScore.toFixed(1), cashflow_score: +cScore.toFixed(1),
    financial_strength_score: +financial_strength_score.toFixed(1),
    piotroski_f: pio, eps_quality_flag: eps_flag,
    accruals_ratio: accruals_ratio != null ? +accruals_ratio.toFixed(3) : null,
    debt_stress_flag: !!debt_stress_flag,
    trailing_eps: ds.eps_data?.trailing_eps ?? null,
    forward_eps: ds.eps_data?.forward_eps ?? null,
    data_sanity_flags: ds.data_sanity_flags || [],
  };
}

module.exports = {
  computeMetrics, cagr, trend, growthScore, profitabilityScore, efficiencyScore,
  cashflowScore, cyclicality, piotroski, epsQualityFlag, stdDev, maxDrawdown,
};
