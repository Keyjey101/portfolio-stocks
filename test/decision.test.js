'use strict';
// Decision engine (04): компоненты, SEC-модификаторы, гейты вердикта,
// уверенность с кэпами, event-флаги D1–D4, mispricing-сверка.
const { test } = require('node:test');
const assert = require('node:assert');
const de = require('../src/equity/decision');

const fm = () => ({
  revenue_cagr_3y: 0.08, revenue_trend: 'improving', margin_trend: 'stable',
  avg_operating_margin: 0.25, avg_roic: 0.28, avg_roe: 0.4,
  fcf_positive_years: 6, fcf_available_years: 6,
  is_cyclical: false, is_highly_cyclical: false, cyclicality_tag: null,
  growth_score: 8, profitability_score: 9, efficiency_score: 9, cashflow_score: 9,
  piotroski_f: 6, eps_quality_flag: 'normal', debt_stress_flag: false,
});
const business = () => ({ business_score: 8, moat_score: 8, moat_type: 'brand' });
const valuation = (over = {}) => ({
  valuation_score: 7, margin_of_safety_pct: 20, low_reliability: false, no_estimate: false,
  asset_light: false, dispersion_flag: false, mos: 20, ...over,
});
const risk = (over = {}) => ({ risk_score: 3, mispricing_type: 'fairly_valued', time_horizon: '3-5 years', ...over });
const ds = () => ({ meta: { sector: 'Technology' }, data_sanity_flags: [], multiples: {} });

test('компоненты: override за высокую маржу и ROIC', () => {
  const c1 = de.componentScores(fm(), business(), valuation(), risk(), ds());
  assert.ok(c1.business_quality >= 70, `базово высоко: ${c1.business_quality}`);
  // слабый бизнес, но op margin 45% и ROIC 25% → флор 70
  const fm2 = { ...fm(), avg_operating_margin: 0.45, avg_roic: 0.25 };
  const b2 = { business_score: 2, moat_score: 2 };
  const c2 = de.componentScores(fm2, b2, valuation(), risk(), ds());
  assert.strictEqual(c2.business_quality, 70, 'жёсткий флор сработал');
  // отрицательный средний ROIC → потолок 40
  const fm3 = { ...fm(), avg_roic: -0.05 };
  const c3 = de.componentScores(fm3, business(), valuation(), risk(), ds());
  assert.ok(c3.business_quality <= 40, `кап при ROIC<0: ${c3.business_quality}`);
});

test('valuation-компонент нейтрален при low_reliability/no_estimate', () => {
  const c = de.componentScores(fm(), business(), valuation({ valuation_score: 9, low_reliability: true }), risk(), ds());
  assert.strictEqual(c.valuation, 50);
  const c2 = de.componentScores(fm(), business(), valuation({ valuation_score: 9, no_estimate: true }), risk(), ds());
  assert.strictEqual(c2.valuation, 50);
});

test('SEC-модификаторы: направления и величины', () => {
  const sec = {
    data_available: true, revenue_change_pct: 5, debt_change_pct: -3, margin_change: 2.5,
    fcf_change_pct: 15, filing_tone: 'positive', institutional_changes: { notable_activity: 'Fidelity +5%' },
  };
  const m = de.secModifiers(sec);
  assert.strictEqual(m.delta, 2 + 1 + 1 + 1 + 1, `+: ${m.delta}`);
  const m2 = de.secModifiers({
    data_available: true, revenue_change_pct: 0, debt_change_pct: 0,
    recent_form4: { sell_count: 10, buy_count: 1, total_sell_value_usd: 9e7, total_buy_value_usd: 1e6 },
    recent_8k_events: [{ event_type: 'restatement' }], filing_tone: 'negative',
  });
  assert.strictEqual(m2.delta, -4 - 5 - 2, `-: ${m2.delta}`);
  assert.strictEqual(de.secModifiers({ data_available: false }).delta, 0);
});

test('вердикты: пороги и гейты', () => {
  const ctx = (over = {}) => ({
    mos: 20, risk: risk(), valuation: valuation(), degraded_agents: 0,
    event_flags: {}, asset_light: false, value_trap: false, ...over,
  });
  assert.strictEqual(de.verdictGates(80, ctx()), 'Strong Buy');
  assert.strictEqual(de.verdictGates(65, ctx()), 'Buy');
  assert.strictEqual(de.verdictGates(50, ctx()), 'Hold');
  assert.strictEqual(de.verdictGates(30, ctx()), 'Avoid');
  // value-trap guard: скор < 70 → Avoid
  assert.strictEqual(de.verdictGates(65, ctx({ value_trap: true })), 'Avoid');
  // MoS ≤ −50 → Avoid
  assert.strictEqual(de.verdictGates(80, ctx({ mos: -55 })), 'Avoid');
  // |MoS| < 5 → Hold
  assert.strictEqual(de.verdictGates(80, ctx({ mos: 2 })), 'Hold');
  // hard gate No Decision
  assert.strictEqual(de.verdictGates(80, ctx({ valuation: valuation({ no_estimate: true }) })), 'No Decision');
  assert.strictEqual(de.verdictGates(80, ctx({ degraded_agents: 1 })), 'No Decision');
  assert.strictEqual(de.verdictGates(80, ctx({ event_flags: { stale_filing: true } })), 'No Decision');
  assert.strictEqual(de.verdictGates(80, ctx({ event_flags: { unexplained_move_severe: true } })), 'No Decision');
  // D4 без severity → Hold
  assert.strictEqual(de.verdictGates(80, ctx({ event_flags: { unexplained_move: true } })), 'Hold');
});

test('уверенность: кэпы', () => {
  const base = { fm: fm(), business: business(), valuation: valuation(), risk: risk(), sec: { data_available: true }, event_flags: {}, degraded_agents: 0, ds: ds() };
  const c = de.confidencePct(base);
  assert.ok(c >= 60, `база высокая: ${c}`);
  const cLow = de.confidencePct({ ...base, valuation: valuation({ low_reliability: true }) });
  assert.ok(cLow <= 40, `кэп low_reliability: ${cLow}`);
  const cDeg = de.confidencePct({ ...base, degraded_agents: 2 });
  assert.ok(cDeg <= 35, `кэп деградации: ${cDeg}`);
  const cCyc = de.confidencePct({ ...base, fm: { ...fm(), is_highly_cyclical: true } });
  assert.ok(cCyc < c, 'высокоцикличная снижает');
});

test('event-флаги D1/D3/D4', () => {
  const now = Date.now();
  const filingTs = now - 30 * 864e5;
  // D1: guidance-событие ПОСЛЕ последнего филлинга
  const f1 = de.computeEventFlags({
    news: { risk_level: 'elevated', events: [{ type: 'guidance', date: new Date(now - 5 * 864e5).toISOString().slice(0, 10), headline: 'cut', summary: '' }] },
    lastFilingTs: filingTs, ret90d: 0.02,
  });
  assert.ok(f1.stale_filing, 'D1 пойман');
  // D3: M&A
  const f2 = de.computeEventFlags({
    news: { risk_level: 'watch', events: [{ type: 'other', headline: 'Company agreed to buy target, $20 per share in cash', summary: '' }] },
    lastFilingTs: filingTs, ret90d: 0.05,
  });
  assert.ok(f2.active_ma_offer, 'D3 пойман');
  // D4: движение без материальных новостей
  const f3 = de.computeEventFlags({
    news: { risk_level: 'none', events: [] }, lastFilingTs: filingTs, ret90d: -0.32,
  });
  assert.ok(f3.unexplained_move && !f3.unexplained_move_severe, 'D4 без severity');
  const f4 = de.computeEventFlags({
    news: { risk_level: 'none', events: [] }, lastFilingTs: filingTs, ret90d: 0.55,
  });
  assert.ok(f4.unexplained_move_severe, 'D4 severe');
});

test('mispricing-сверка с вердиктом', () => {
  assert.strictEqual(de.reconcileMispricing('opportunity', 'Buy'), 'opportunity');
  assert.strictEqual(de.reconcileMispricing('opportunity', 'Avoid'), 'unknown');
  assert.strictEqual(de.reconcileMispricing('value_trap', 'Strong Buy'), 'unknown');
  assert.strictEqual(de.reconcileMispricing('fairly_valued', 'Hold'), 'fairly_valued');
});

test('decide: скор-уверенность связаны; полный блок', () => {
  const out = de.decide({
    ds: ds(), fm: fm(), business: business(), valuation: valuation(), risk: risk(),
    sec: { data_available: false }, event_flags: {}, degraded_agents: 0,
  });
  assert.ok(out.total_score <= 40 + 0.6 * out.confidence_pct + 1e-6, 'скор ≤ 40+0.6·conf');
  assert.ok(['Strong Buy', 'Buy', 'Hold', 'Avoid', 'No Decision'].includes(out.verdict));
  assert.ok(out.confidence_pct >= 20 && out.confidence_pct <= 90);
  assert.ok(out.component_scores.business_quality > 0);
});

test('decide: self-critique корректирует уверенность', () => {
  const pre = de.decide({
    ds: ds(), fm: fm(), business: business(), valuation: valuation(), risk: risk(),
    sec: { data_available: true }, event_flags: {}, degraded_agents: 0,
  });
  const post = de.decide({
    ds: ds(), fm: fm(), business: business(), valuation: valuation(), risk: risk(),
    sec: { data_available: true }, event_flags: {}, degraded_agents: 0,
    self_critique: { bear_case: 'x', confidence_adjustment: -20, missed_risks: ['r'], final_assessment: 'strong_caution' },
  });
  if (pre.confidence_pct >= 80) {
    assert.ok(post.confidence_pct < pre.confidence_pct, `${pre.confidence_pct} → ${post.confidence_pct}`);
  }
});
