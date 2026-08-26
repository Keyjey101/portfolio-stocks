'use strict';
// Financial-агент (03 §3.11): CAGR, тренды, лестницы скоров, цикличность,
// Piotroski, eps_quality, композит по синтетическому датасету.
const { test } = require('node:test');
const assert = require('node:assert');
const fin = require('../src/equity/financial');

// производные ряды: свежие первыми
function mkDerived({ years = 6, g = 0.1, om = 0.2 } = {}) {
  const d = { year: [] };
  for (let i = 0; i < years; i++) {
    const y = 2026 - i;
    const idx = d.year.length;
    d.year.push(y);
    const push = (k, v) => { (d[k] = d[k] || [])[idx] = v; };
    const rev = 10e9 * Math.pow(1 + g, years - 1 - i);
    const oi = rev * om, ni = oi * 0.75;
    push('revenue', rev); push('operating_income', oi); push('net_income', ni);
    push('ebitda', oi * 1.2); push('total_debt', rev * 0.3); push('total_equity', rev * 0.6);
    push('cash', rev * 0.1); push('total_assets', rev * 1.5);
    push('operating_cf', ni * 1.2); push('capex', -rev * 0.04);
    push('free_cash_flow', ni * 1.2 - rev * 0.04);
    push('operating_margin', om); push('roic', ni / (rev * 0.8)); push('roe', ni / (rev * 0.6));
    push('gross_margin', om + 0.2); push('debt_ebitda', rev * 0.3 / (oi * 1.2));
    push('interest_coverage', 20); push('fcf_conversion', 1.1); push('eps', ni / 1e9);
    push('interest_expense', rev * 0.005);
  }
  return d;
}
function mkDs(over = {}) {
  return {
    meta: { ticker: 'T', sector: over.sector || 'Technology', industry: over.industry || 'Software' },
    derived: over.derived || mkDerived(over.series || {}),
    multiples: { pe_trailing: 20, pe_forward: 18, ...(over.multiples || {}) },
    eps_data: { trailing_eps: 2, forward_eps: 2.2 },
    data_sanity_flags: [],
    ...(over.raw || {}),
  };
}

test('CAGR по ряду свежие-первыми', () => {
  assert.ok(Math.abs(fin.cagr([110, 100], 2) - 0.10) < 1e-9, 'один год');
  assert.ok(Math.abs(fin.cagr([133.1, 121, 110, 100], 4) - 0.10) < 1e-9, 'три года');
  assert.strictEqual(fin.cagr([5, 0], 2), null, 'нулевая база');
  assert.strictEqual(fin.cagr([1], 1), null);
});

test('лестницы скоров', () => {
  assert.strictEqual(fin.growthScore(0.2, 'stable'), 9.5);
  assert.strictEqual(fin.growthScore(0.12, 'stable'), 8);
  assert.strictEqual(fin.growthScore(0.06, 'improving'), 6.5 + 1.5);
  assert.strictEqual(fin.growthScore(-0.05, 'declining'), 1.5 - 0.5);
  assert.strictEqual(fin.profitabilityScore(0.3), 9.5);
  assert.strictEqual(fin.profitabilityScore(-0.1), 1);
  assert.strictEqual(fin.efficiencyScore(0.25), 9.5);
  assert.strictEqual(fin.efficiencyScore(0.03), 2.5);
  const cs = fin.cashflowScore({ fcfPosShare: 0.9, fcfConv: 0.9, debtEbitda: 0.5, currentDebtRatio: 0, interestCoverage: 30 });
  assert.ok(cs >= 9, `fcf-сильная: ${cs}`);
  const cs2 = fin.cashflowScore({ fcfPosShare: 0.2, debtEbitda: 5, interestCoverage: 1.5, currentDebtRatio: 0.5 });
  assert.ok(cs2 <= 1, `fcf-слабая с долгами: ${cs2}`);
});

test('цикличность: сектор + подтверждение данными', () => {
  const stable = fin.cyclicality({ sector: 'Technology', industry: 'Software', marginStd: 0.01, revDrawdown: -0.05 });
  assert.ok(!stable.is_cyclical);
  const dataCyc = fin.cyclicality({ sector: 'Technology', industry: 'Software', marginStd: 0.09, revDrawdown: -0.3 });
  assert.ok(dataCyc.is_cyclical, 'данные перевешивают сектор');
  const oil = fin.cyclicality({ sector: 'Energy', industry: 'Oil & Gas', marginStd: 0.01, revDrawdown: -0.05 });
  assert.ok(oil.is_cyclical && oil.is_highly_cyclical);
  const semi = fin.cyclicality({ sector: 'Technology', industry: 'Semiconductors', marginStd: 0.01, revDrawdown: -0.05 });
  assert.ok(semi.is_highly_cyclical, 'структурный кейворд');
});

test('epsQualityFlag', () => {
  assert.strictEqual(fin.epsQualityFlag(20, 31), 'suspicious_trailing_pe');  // fwd на 55% выше
  assert.strictEqual(fin.epsQualityFlag(20, 27), 'likely_one_time_gain');    // +35%
  assert.strictEqual(fin.epsQualityFlag(20, 22), 'normal');
  assert.strictEqual(fin.epsQualityFlag(20, 16), 'expected_growth');         // −20%
  assert.strictEqual(fin.epsQualityFlag(null, 10), 'normal');
});

test('computeMetrics: композит и поля', () => {
  const m = fin.computeMetrics(mkDs());
  assert.ok(Math.abs(m.revenue_cagr_3y - 0.1) < 0.02, `cagr3 ≈ g: ${m.revenue_cagr_3y}`);
  assert.strictEqual(m.revenue_trend, 'stable');
  assert.ok(m.financial_strength_score > 5, `сильная компания: ${m.financial_strength_score}`);
  assert.ok(m.piotroski_f >= 4 && m.piotroski_f <= 8, `piotrosko в рамках: ${m.piotroski_f}`);
  assert.strictEqual(m.eps_quality_flag, 'normal');
  assert.ok(m.fcf_positive_years === 6);
  assert.ok(!m.is_cyclical);
});

test('computeMetrics: деградация видна', () => {
  // выручка падает, маржа падает
  const d = mkDerived({ g: -0.15, om: 0.05 });
  const m = fin.computeMetrics(mkDs({ derived: d }));
  assert.strictEqual(m.revenue_trend, 'declining');
  assert.ok(m.growth_score <= 2, `скор роста низкий: ${m.growth_score}`);
});

test('Piotroski: рост прибыли/маржи засчитывается', () => {
  const d = mkDerived({ g: 0.2, om: 0.25 });
  const m = fin.computeMetrics(mkDs({ derived: d }));
  assert.ok(m.piotroski_f >= 5, `растущая компания: ${m.piotroski_f}`);
});
