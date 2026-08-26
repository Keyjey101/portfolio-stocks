'use strict';
// Сканер (06): прескрин-скор, фильтры, вердикты, red flags, value-trap,
// постфильтр+ранжирование, кластерное предупреждение, camelCase-строки.
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../src/equity/scanner');

const q = (over = {}) => ({
  ticker: 'TST', sector: 'Technology', current_price: 50, market_cap: 5e9, avg_volume: 2e6,
  pe_trailing: 12, pe_forward: 11, pb: 1.2, roe: 0.18, dividend_yield: null, payout_ratio: null,
  revenue_growth: 0.1, profit_margin: 0.12, beta: 0.9, ...over,
});

test('прескрин-скор undervalued: дёшево+качество выше, дорого ниже', () => {
  const cheap = sc.prescreenScore(q(), 'undervalued');
  assert.ok(cheap > 70, `дёшево и качественно: ${cheap}`);
  const exp = sc.prescreenScore(q({ pe_trailing: 70, pb: 9, roe: 0.02, revenue_growth: -0.1, profit_margin: -0.05, beta: 2.5 }), 'undervalued');
  assert.ok(exp < 40, `дорого и плохо: ${exp}`);
  const susp = sc.prescreenScore(q({ pe_trailing: 4 }), 'undervalued');
  assert.ok(susp < cheap, 'подозрительно дёшево штрафуется');
  const fwd = sc.prescreenScore(q({ pe_forward: 18, pe_trailing: 12 }), 'undervalued');
  assert.ok(fwd < cheap, 'forward >> trailing штрафуется');
});

test('прескрин-скор dividend: лестницы yield/payout', () => {
  const good = sc.prescreenScore(q({ dividend_yield: 0.04, payout_ratio: 0.4, roe: 0.18, profit_margin: 0.15, beta: 0.7 }), 'dividend');
  assert.ok(good > 80, `здоровый дивидендист: ${good}`);
  const trap = sc.prescreenScore(q({ dividend_yield: 0.13, payout_ratio: 0.95, roe: -0.05, profit_margin: -0.02 }), 'dividend');
  assert.ok(trap < 40, `ловушка: ${trap}`);
});

test('фильтры: капитализация, объём, сектор, жёсткие условия', () => {
  const p = sc.normParams({ scanType: 'undervalued', marketCapTier: 'mid', volumeTier: 'medium', sector: 'Technology' });
  assert.ok(!sc.passesFilter(q({ market_cap: 1e9 }), p), 'ниже micro-cap порога');
  assert.ok(!sc.passesFilter(q({ avg_volume: 1e3 }), p), 'ниже объёма');
  assert.ok(!sc.passesFilter(q({ sector: 'Energy' }), p), 'не тот сектор');
  assert.ok(!sc.passesFilter(q({ pe_trailing: 150 }), p), 'P/E > 80');
  assert.ok(sc.passesFilter(q(), p), 'проходит');
  const pd = sc.normParams({ scanType: 'dividend' });
  assert.ok(!sc.passesFilter(q({ dividend_yield: 0.002 }), pd), 'yield < 0.5%');
  assert.ok(!sc.passesFilter(q({ dividend_yield: 0.03, payout_ratio: 2 }), pd), 'payout > 1.5');
  assert.ok(sc.passesFilter(q({ dividend_yield: 0.03, payout_ratio: 0.5 }), pd), 'дивидендный проходит');
});

test('нормализация параметров', () => {
  const p = sc.normParams({ topN: 33, scanType: 'growth', sector: 'Nonsense' });
  assert.strictEqual(p.topN, 20);
  assert.strictEqual(p.scanType, 'undervalued');
  assert.strictEqual(p.sector, null);
});

test('вердикт скана по MoS', () => {
  assert.strictEqual(sc.scanVerdict(45), 'STRONGLY UNDERVALUED');
  assert.strictEqual(sc.scanVerdict(20), 'MODERATELY UNDERVALUED');
  assert.strictEqual(sc.scanVerdict(0), 'FAIRLY VALUED');
  assert.strictEqual(sc.scanVerdict(-15), 'MODERATELY OVERVALUED');
  assert.strictEqual(sc.scanVerdict(-40), 'STRONGLY OVERVALUED');
});

test('red flags: критичные и предупреждения', () => {
  const fm = {
    revenue_trend: 'declining', margin_trend: 'declining', is_cyclical: false,
    avg_interest_coverage: 1.5, piotroski_f: 2, avg_roe: -0.05, avg_roic: -0.02,
    growth_score: 1.5,
  };
  const ds = {
    derived: { free_cash_flow: [-1e9], net_debt: [40e9], ebitda: [8e9] },
    dividend_data: { payout_ratio: 0.95 },
  };
  const rf = sc.redFlags({ industry: 'Software' }, fm, ds);
  assert.ok(rf.critical >= 3, `критичных ≥3: ${rf.critical}`);
  assert.ok(rf.items.some(i => i.includes('FCF')));
  // финансы пропускают FCF/Piotroski/левередж
  const rfFin = sc.redFlags({ industry: 'Banks' }, fm, ds);
  assert.ok(!rfFin.items.some(i => i.includes('NetDebt')), 'банкам долговые флаги не ставим');
});

test('qualityAdjust: деградация демотирует, качество со скидкой мотивирует', () => {
  const base = {
    prescreen_score: 80, sector_quality: 8.5, industry: 'Software', peak_margin_flag: false,
    red_flags: { critical: 0, warnings: 0 },
  };
  const up = sc.qualityAdjust(base, { is_highly_cyclical: false, is_cyclical: false, revenue_trend: 'stable', avg_roic: 0.3 }, 20);
  assert.strictEqual(up.total, 90, 'качество ≥8 + MoS>15 + чисто = +10');
  const down = sc.qualityAdjust({ ...base, sector_quality: 5 }, { revenue_trend: 'declining', margin_trend: 'stable', is_cyclical: false, avg_roic: 0.05 }, 20);
  assert.ok(down.total <= 80 - 15, `ROIC<10 + спад: ${down.total}`);
});

test('value-trap чек', () => {
  const row = { red_flags: { critical: 4, warnings: 0 }, extreme_gap_warning: false };
  const vt = sc.valueTrapCheck(40, { is_highly_cyclical: false, margin_trend: 'declining', revenue_trend: 'stable', piotroski_f: 5 }, row);
  assert.ok(vt.warning, '≥3 critical → trap');
  const ok = sc.valueTrapCheck(40, { is_highly_cyclical: false, margin_trend: 'stable', revenue_trend: 'improving', piotroski_f: 7 }, { red_flags: { critical: 0, warnings: 1 }, extreme_gap_warning: false });
  assert.ok(!ok.warning);
  assert.ok(!sc.valueTrapCheck(10, { piotroski_f: 1, margin_trend: 'declining', revenue_trend: 'declining' }, row).warning, 'MoS ≤ 30 не считается');
});

test('постфильтр и ранжирование: сильные выживают, скор согласован', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      ticker: 'T' + i, sector: 'Technology', total_score: 60 + i,
      valuation_score: 5 + (i % 4), valuation: { marginOfSafety: 8 + i },
      avg_roic: 0.1, fcf_yield: 0.05, current_price: 10, industry: 'Software',
    });
  }
  rows[3].valuation.marginOfSafety = -40; // слабак
  const ranked = sc.postfilterAndRank(rows, 5);
  assert.strictEqual(ranked.length, 5);
  assert.ok(ranked[0].scan_score >= ranked[ranked.length - 1].scan_score, 'сортировка по scan_score');
  assert.ok(!ranked.some(r => r.valuation.marginOfSafety === -40), 'постфильтр выкинул слабака');
  assert.strictEqual(ranked[0].rank, 1);
});

test('кластерное предупреждение', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push({ sector: i < 5 ? 'Energy' : 'Technology', news_radar: { level: 'none' } });
  assert.ok(sc.clusterWarning(rows).includes('Energy'));
  const mixed = [
    { sector: 'A', news_radar: { level: 'none' } }, { sector: 'B', news_radar: { level: 'none' } },
    { sector: 'C', news_radar: { level: 'none' } }, { sector: 'D', news_radar: { level: 'none' } },
    { sector: 'E', news_radar: { level: 'none' } }, { sector: 'F', news_radar: { level: 'none' } },
    { sector: 'G', news_radar: { level: 'none' } },
  ];
  assert.strictEqual(sc.clusterWarning(mixed), null, 'разброс — без предупреждения');
});

test('sectorQuality: финансы по ROE-лестнице, прочие по business_score с флором/капом', () => {
  const finRow = { industry: 'Banks' };
  const q1 = sc.sectorQuality(finRow, { avg_roe: 0.18 }, { business_score: 6 });
  const q2 = sc.sectorQuality(finRow, { avg_roe: -0.05 }, { business_score: 6 });
  assert.ok(q1 > q2, `ROE-лестница: ${q1} > ${q2}`);
  const soft = { industry: 'Software' };
  const q3 = sc.sectorQuality(soft, { avg_roic: 0.35, avg_operating_margin: 0.45 }, { business_score: 3 });
  assert.ok(q3 >= 7, 'флор 7 за ROIC+маржу');
  const q4 = sc.sectorQuality(soft, { avg_roic: -0.1, avg_operating_margin: 0.1 }, { business_score: 8 });
  assert.ok(q4 <= 4, 'кап 4 при ROIC < 0');
});
