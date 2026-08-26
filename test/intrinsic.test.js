'use strict';
// Движок оценки (03): стоимость капитала, рост, методы, агрегация, гейты.
const { test } = require('node:test');
const assert = require('node:assert');
const iv = require('../src/equity/intrinsic');

// синтетический датасет: прибыльная стабильная компания, свежие первыми
function mkSeries({ years = 6, rev0 = 50e9, g = 0.08, om = 0.25, niM = 0.2 } = {}) {
  const d = { year: [] };
  for (let i = 0; i < years; i++) {
    const y = 2026 - i;
    const idx = d.year.length;
    d.year.push(y);
    const push = (k, v) => { (d[k] = d[k] || [])[idx] = v; };
    const rev = rev0 * Math.pow(1 + g, years - 1 - i);
    const oi = rev * om, ni = rev * niM;
    push('revenue', rev); push('gross_profit', rev * 0.45); push('operating_income', oi);
    push('net_income', ni); push('ebitda', oi * 1.25); push('interest_expense', rev * 0.01);
    push('total_assets', rev * 1.2); push('total_equity', rev * 0.5); push('total_debt', rev * 0.3);
    push('cash', rev * 0.1); push('operating_cf', ni * 1.3); push('capex', -rev * 0.05);
    push('dividends_paid', -ni * 0.2);
    push('free_cash_flow', ni * 1.3 - rev * 0.05);
    push('eps', ni / 1e9);
    push('operating_margin', om); push('roic', ni / (rev * 0.7));
    push('roe', ni / (rev * 0.5));
  }
  return d;
}

function mkDs(over = {}) {
  return {
    meta: {
      ticker: 'TST', name: 'Test Co', sector: 'Technology', industry: 'Software',
      current_price: 100, market_cap: 1e11, enterprise_value: 1.02e11,
      shares_outstanding: 1e9, beta: 1.1, ...over.meta,
    },
    derived: mkSeries(over.series || {}),
    multiples: { pe_trailing: 25, pe_forward: 22, pb: 8, ev_ebitda: 18, fcf_yield: 0.02, ...over.multiples },
    eps_data: { trailing_eps: 4, forward_eps: 4.5, annual_earnings: [] },
    analyst: { target_mean: 110, eps_growth_next_year: 0.1, eps_growth_next_5y: 0.09, ...over.analyst },
    dividend_data: { yield: 0.005 },
    data_sanity_flags: [],
    ...over.raw,
  };
}
function mkFm(over = {}) {
  return {
    revenue_cagr_3y: 0.08, revenue_cagr_5y: 0.075, eps_cagr_3y: 0.09, eps_cagr_5y: 0.08,
    revenue_trend: 'improving', margin_trend: 'stable',
    avg_operating_margin: 0.25, avg_roic: 0.28, avg_roe: 0.4,
    avg_debt_ebitda: 0.9, avg_interest_coverage: 25,
    fcf_positive_years: 6, fcf_available_years: 6,
    is_cyclical: false, is_highly_cyclical: false, cyclicality_tag: null,
    growth_score: 8, profitability_score: 9.5, efficiency_score: 9.5, cashflow_score: 9,
    piotroski_f: 6, eps_quality_flag: 'normal', debt_stress_flag: false,
    ...over,
  };
}

test('costOfCapital: беты, клампы, структура', () => {
  const cc = iv.costOfCapital(mkDs(), mkFm(), 4.3);
  assert.ok(cc.wacc > 0.05 && cc.wacc < 0.20, `wacc в пределах: ${cc.wacc}`);
  assert.ok(cc.ke >= cc.rf + 0.045 - 1e-9, 'ke ≥ rf+4.5п.п.');
  assert.ok(cc.tax >= 0.10 && cc.tax <= 0.35, `tax кламп: ${cc.tax}`);
  // Blume: beta 1.1 → 0.67·1.1+0.33 = 1.067
  assert.ok(Math.abs(cc.beta - 1.067) < 0.01, `blume-бета ${cc.beta}`);
});

test('compute: полный выход стабильной компании', () => {
  const val = iv.compute(mkDs(), mkFm());
  assert.ok(val.base > 0, 'base > 0');
  assert.ok(val.bear < val.base && val.base < val.bull, 'сценарии упорядочены');
  assert.ok(val.expected_value > 0);
  const names = val.methods.map(m => m.name);
  for (const want of ['dcf', 'epv', 'pe', 'ev_ebitda', 'graham', 'analyst']) {
    assert.ok(names.includes(want), `метод ${want} присутствует: ${names}`);
  }
  assert.strictEqual(val.data_quality, 'ok');
  assert.ok(!val.no_estimate, 'без флагов ненадёжности');
  // MoS согласован с base/price
  const mos = (val.base - 100) / 100 * 100;
  assert.ok(Math.abs(val.margin_of_safety_pct - Math.round(mos * 10) / 10) < 0.11, `MoS: ${val.margin_of_safety_pct}`);
  assert.strictEqual(val.probabilities.base, 0.5);
  assert.ok(val.framing.includes('поддерживает'), 'framing на русском');
});

test('банк: P/B вместо DCF/EPV', () => {
  const ds = mkDs({ meta: { industry: 'Banks', sector: 'Financial Services' } });
  const fm = mkFm({ avg_roe: 0.12, avg_roic: null });
  const val = iv.compute(ds, fm);
  const names = val.methods.map(m => m.name);
  assert.ok(names.includes('pb'), 'P/B есть');
  const w = iv.weightsFor(ds, fm, {});
  assert.strictEqual(w.pb, 0.45);
  assert.strictEqual(w.dcf, 0);
});

test('лестница MoS-скора', () => {
  assert.strictEqual(iv.marginOfSafetyScore(45), 9);
  assert.strictEqual(iv.marginOfSafetyScore(20), 7);
  assert.strictEqual(iv.marginOfSafetyScore(0), 5);
  assert.strictEqual(iv.marginOfSafetyScore(-5), 5);   // > −10
  assert.strictEqual(iv.marginOfSafetyScore(-15), 3);  // > −25
  assert.strictEqual(iv.marginOfSafetyScore(-60), 1);
  assert.strictEqual(iv.marginOfSafetyScore(null), 5);
});

test('гейты: кламп к цене и no_estimate при диком разлёте методов', () => {
  // аналитики-цель в 3× от цены → fv_target_gap большой → no_estimate
  const ds = mkDs({ analyst: { target_mean: 400, eps_growth_next_year: 0.1 } });
  const val = iv.compute(ds, mkFm());
  assert.ok(val.no_estimate || val.fv_target_gap > 1, 'разрыв с консенсусом пойман');
});

test('рост: клампы и спад выручки', () => {
  const fm = mkFm({ revenue_cagr_3y: 0.5, revenue_cagr_5y: 0.45, eps_cagr_5y: 0.9, eps_cagr_3y: 0.8, revenue_trend: 'improving' });
  const g = iv.centralGrowth(mkDs(), fm);
  assert.ok(g <= 0.4, `кламп g ≤ 40%: ${g}`);
  const fm2 = mkFm({ revenue_cagr_3y: -0.2, revenue_cagr_5y: -0.1, eps_cagr_5y: 0.3, eps_cagr_3y: 0.2, revenue_trend: 'declining' });
  const g2 = iv.centralGrowth(mkDs(), fm2);
  assert.ok(g2 <= 0 && g2 >= -0.1, `спад давит рост: ${g2}`);
});

test('нормализация: цикличная компания расширяет диапазон', () => {
  const ds = mkDs({ series: { g: 0.15, om: 0.2 } });
  const fm = mkFm({ is_cyclical: true, is_highly_cyclical: true, cyclicality_tag: 'highly_cyclical' });
  const val = iv.compute(ds, fm);
  assert.ok(val.valuation_flags.includes('cyclical_range_only'), 'флаг цикличного диапазона');
  assert.ok(val.no_estimate, 'высокоцикличная → no_estimate');
  assert.ok(val.range_low <= 0.6 * val.base + 1e-6, 'диапазон расширен вниз');
});

test('robustAggregate: выброс получает затухающий вес', () => {
  const methods = [
    { name: 'dcf', value: 100 }, { name: 'pe', value: 102 },
    { name: 'ev_ebitda', value: 98 }, { name: 'analyst', value: 101 },
    { name: 'graham', value: 20 },
  ];
  const weights = { dcf: 0.3, pe: 0.22, ev_ebitda: 0.15, analyst: 0.1, graham: 0.08, pb: 0, dcf2: 0 };
  const agg = iv.robustAggregate(methods, weights);
  assert.ok(agg.base > 90 && agg.base < 105, `выброс Грэма не утащил якорь: ${agg.base}`);
});

test('пустые fundamentals у цикличного тикера — не краш, а no_estimate (регрессия AVGO)', () => {
  // Yahoo fundamentals не ответил с IP дата-центра: annual-стейтментов нет,
  // derived = {year:[]} без ряда revenue; цикличность определена по сектору.
  // Раньше: TypeError: Cannot read properties of undefined (reading 'slice').
  const ds = mkDs();
  ds.derived = { year: [] };
  const val = iv.compute(ds, mkFm({ is_cyclical: true, is_highly_cyclical: true }));
  assert.ok(val.no_estimate, 'нет надёжной оценки вместо TypeError');
});
