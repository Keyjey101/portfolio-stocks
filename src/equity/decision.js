// Decision engine (спека 04): компоненты скора, секторные веса, SEC-модификаторы,
// вердикт с последовательными гейтами, уверенность с кэпами, self-critique,
// сверка mispricing. Вердикт зависит ТОЛЬКО от кода — LLM-числа не переопределяют.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const norm10 = x => x * 10; // 0–10 → 0–100

const SECTOR_WEIGHTS = {
  default:        { business: .30, financial: .25, growth: .20, valuation: .15, risk: .10 },
  'Financial Services': { business: .20, financial: .35, growth: .15, valuation: .15, risk: .15 },
  Technology:     { business: .25, financial: .15, growth: .30, valuation: .15, risk: .15 },
  Energy:         { business: .20, financial: .25, growth: .10, valuation: .30, risk: .15 },
  'Basic Materials':    { business: .20, financial: .25, growth: .10, valuation: .30, risk: .15 },
  'Real Estate':  { business: .20, financial: .25, growth: .10, valuation: .30, risk: .15 },
  'Consumer Defensive': { business: .30, financial: .25, growth: .15, valuation: .20, risk: .10 },
  'Consumer Cyclical':  { business: .25, financial: .20, growth: .30, valuation: .15, risk: .10 },
};

// ── 4.1 компоненты скора ──
function componentScores(fm, business, valuation, risk, ds) {
  const bs = business?.business_score ?? 5;
  const ms = business?.moat_score ?? 5;
  let business_quality = norm10(bs) * 0.6 + norm10(ms) * 0.4;
  // жёсткие overrides
  const om = fm.avg_operating_margin, roic = fm.avg_roic;
  if (om != null && roic != null && om > 0.40 && roic > 0.20) business_quality = Math.max(business_quality, 70);
  if (roic != null && roic < 0) business_quality = Math.min(business_quality, 40);

  const financial_strength = norm10(fm.profitability_score ?? 5) * 0.40
    + norm10(fm.efficiency_score ?? 5) * 0.33
    + norm10(fm.cashflow_score ?? 5) * 0.27;

  const growth = norm10(fm.growth_score ?? 5);

  let valuation_cmp = norm10(valuation?.valuation_score ?? 5);
  if (valuation?.low_reliability || valuation?.no_estimate) valuation_cmp = 50.0;

  const riskScore = risk?.risk_score ?? 5;
  let risk_cmp = norm10(10 - riskScore);
  if (risk?.mispricing_type === 'value_trap') risk_cmp -= 20;
  if (risk?.mispricing_type === 'opportunity') risk_cmp += 5;

  return {
    business_quality: +clamp(business_quality, 0, 100).toFixed(1),
    financial_strength: +clamp(financial_strength, 0, 100).toFixed(1),
    growth: +clamp(growth, 0, 100).toFixed(1),
    valuation: +clamp(valuation_cmp, 0, 100).toFixed(1),
    risk: +clamp(risk_cmp, 0, 100).toFixed(1),
  };
}

// ── 4.2 SEC-модификаторы ──
function secModifiers(sec) {
  let delta = 0;
  if (!sec || !sec.data_available) return { delta, reasons: [] };
  const reasons = [];
  if ((sec.revenue_change_pct ?? 0) > 0 && (sec.debt_change_pct ?? 0) < 0) { delta += 2; reasons.push('выручка растёт при снижении долга +2'); }
  const f4 = sec.recent_form4 || {};
  if ((f4.total_sell_value_usd ?? 0) > 3 * Math.max(1, f4.total_buy_value_usd ?? 0) && f4.sell_count > 0) { delta -= 4; reasons.push('инсайдеры продают втрое чаще покупок −4'); }
  if ((f4.total_buy_value_usd ?? 0) > 2 * Math.max(1, f4.total_sell_value_usd ?? 0) && f4.buy_count > 0) { delta += 2; reasons.push('инсайдеры покупают вдвое чаще продаж +2'); }
  if ((sec.margin_change ?? 0) > 2) { delta += 1; reasons.push('маржа выросла >2 п.п. +1'); }
  if ((sec.fcf_change_pct ?? 0) > 10) { delta += 1; reasons.push('FCF вырос >10% +1'); }
  const nRestate = (sec.recent_8k_events || []).filter(e => e.event_type === 'restatement').length;
  if (nRestate) { delta -= 5 * nRestate; reasons.push(`8-K restatement ×${nRestate} −${5 * nRestate}`); }
  const nLeadership = (sec.recent_8k_events || []).filter(e => e.event_type === 'leadership_change').length;
  if (nLeadership) { delta -= 2 * nLeadership; reasons.push(`смена руководства ×${nLeadership} −${2 * nLeadership}`); }
  if (sec.filing_tone === 'cautious' || sec.filing_tone === 'negative') { delta -= 2; reasons.push('осторожный тон отчёта −2'); }
  if (sec.filing_tone === 'positive') { delta += 1; reasons.push('позитивный тон отчёта +1'); }
  if (sec.institutional_changes?.notable_activity) { delta += 1; reasons.push('заметная активность институционалов +1'); }
  return { delta, reasons };
}

// ── 4.3 вердикт: пороги + последовательные гейты (порядок важен, hard gate
// №5 перебивает всё, что наслоили гейты 1–4) ──
function verdictGates(total, ctx) {
  let v;
  if (total >= 75) v = 'Strong Buy';
  else if (total >= 60) v = 'Buy';
  else if (total >= 40) v = 'Hold';
  else v = 'Avoid';

  const { mos, risk, valuation, degraded_agents, event_flags, asset_light, value_trap } = ctx;
  const mosNum = mos ?? 0;
  const isTrap = value_trap || risk?.mispricing_type === 'value_trap';
  const overpricedFlag = risk?.mispricing_type === 'overvalued_justified' || risk?.mispricing_type === 'overvalued_bubble';

  // 1. value-trap guard
  if (isTrap) {
    if (total < 70) v = 'Avoid';
    else if (v === 'Buy' || v === 'Strong Buy') v = 'Hold';
  }
  // 2. гейты MoS (пропускаются при low_reliability)
  if (!(valuation?.low_reliability)) {
    if (mosNum <= -50 || (overpricedFlag && mosNum <= -35)) v = 'Avoid';
    if (mosNum <= -25 && (v === 'Buy' || v === 'Strong Buy')) v = 'Hold';
    if (Math.abs(mosNum) < 5 && ['Strong Buy', 'Buy', 'Avoid'].includes(v)) v = 'Hold';
  }
  // 3. asset_light + Avoid (не value trap) → Hold
  if (asset_light && v === 'Avoid' && !isTrap) v = 'Hold';
  // 4. деградация агентов смягчает покупку
  if ((degraded_agents || 0) > 0 && (v === 'Buy' || v === 'Strong Buy')) v = 'Hold';
  // 5. hard gate No Decision
  if (valuation?.no_estimate || (degraded_agents || 0) > 0 || event_flags?.stale_filing
    || event_flags?.active_ma_offer || event_flags?.unexplained_move_severe) v = 'No Decision';
  // 6. D4
  if (event_flags?.unexplained_move && ['Strong Buy', 'Buy', 'Avoid'].includes(v)) v = 'Hold';
  return v;
}

// ── 4.4 уверенность ──
function confidencePct(ctx) {
  const { fm, business, valuation, risk, sec, event_flags, degraded_agents, ds } = ctx;
  let c = 50;
  if (fm.fcf_available_years >= 3 && fm.fcf_positive_years / Math.max(1, fm.fcf_available_years) >= 0.85) c += 10;
  if ((fm.piotroski_f ?? 5) >= 7) c += 10;
  if ((fm.piotroski_f ?? 5) <= 3) c -= 10;
  if ((business?.moat_score ?? 5) >= 7) c += 10;
  if (['opportunity', 'value_trap'].includes(risk?.mispricing_type)) c += 5;
  if (fm.is_highly_cyclical) c -= 15;
  if (sec?.data_available) c += 5;
  if (valuation?.dispersion_flag) c -= 10;

  c = clamp(c, 20, 90);
  // кэпы
  if (valuation?.low_reliability) c = Math.min(c, 40);
  if ((degraded_agents || 0) > 0) c = Math.min(c, 45 - 5 * degraded_agents);
  if (event_flags?.unexplained_move) c = Math.min(c, 40);
  if (valuation?.asset_light && valuation?.mos != null && Math.abs(valuation.mos) >= 25) c = Math.min(c, 55);
  const structural = (ds?.data_sanity_flags || []).filter(f =>
    ['gross_profit_implausible', 'revenue_discontinuity', 'negative_book_equity'].includes(f));
  if (structural.length) c = Math.min(Math.min(c, 55) - 10 * structural.length, 20);
  return Math.round(clamp(c, 20, 90));
}

// ── 4.6 mispricing: сверка с вердиктом ──
function reconcileMispricing(mp, verdict) {
  if (!mp) return 'unknown';
  const buyish = verdict === 'Strong Buy' || verdict === 'Buy';
  if (mp === 'opportunity' && !buyish && verdict !== 'Hold') return 'unknown';
  if (mp === 'value_trap' && buyish) return 'unknown';
  if (mp === 'overvalued_bubble' && buyish) return 'unknown';
  return mp;
}

// ── 4.7 event-флаги D1–D4 (вычисляются на шаге news_radar) ──
const MATERIAL_TYPES = new Set(['guidance', 'regulatory', 'fraud', 'accounting', 'short_seller', 'litigation']);
const MA_PATTERNS = /tender offer|to acquire|acquisition of|buyout|take private|merger agreement|agreed to buy|per share in cash|all-cash|to be acquired|takeover bid|go private/i;

function computeEventFlags({ news, lastFilingTs, ret90d }) {
  const level = news?.risk_level || 'unknown';
  const events = news?.events || [];
  const hasMaterial = ['elevated', 'severe'].includes(level)
    || events.some(e => MATERIAL_TYPES.has(e.type));

  // D1: материальное событие датировано ПОСЛЕ последнего 10-Q/10-K
  let stale_filing = false;
  if (lastFilingTs != null && hasMaterial) {
    stale_filing = events.some(e => {
      const ts = e.date ? Date.parse(e.date) : NaN;
      return Number.isFinite(ts) && ts > lastFilingTs && MATERIAL_TYPES.has(e.type);
    });
  }

  // D3: M&A в заголовке/саммари
  const blob = events.map(e => `${e.headline || ''} ${e.summary || ''}`).join(' ') + ' ' + (news?.summary || '');
  const active_ma_offer = MA_PATTERNS.test(blob);

  // D4: движение без материальных новостей и без M&A
  let unexplained_move = false, unexplained_move_severe = false;
  if (!hasMaterial && !active_ma_offer && ret90d != null) {
    if (Math.abs(ret90d) > 0.25) unexplained_move = true;
    if (Math.abs(ret90d) > 0.40) unexplained_move_severe = true;
  }

  return {
    stale_filing, active_ma_offer, unexplained_move, unexplained_move_severe,
    return_90d: ret90d != null ? +ret90d.toFixed(3) : null,
    news_risk_level: level,
  };
}

// ── главный вход ──
function decide({ ds, fm, business, valuation, risk, sec, event_flags, degraded_agents = 0, self_critique = null }) {
  const comps = componentScores(fm, business, valuation, risk, ds);
  const w = SECTOR_WEIGHTS[ds?.meta?.sector] || SECTOR_WEIGHTS.default;
  let total = comps.business_quality * w.business + comps.financial_strength * w.financial
    + comps.growth * w.growth + comps.valuation * w.valuation + comps.risk * w.risk;

  if (fm.is_highly_cyclical && fm.margin_trend === 'declining') total -= 5;
  const secMod = secModifiers(sec);
  total += secMod.delta;

  const ctx = {
    mos: valuation?.margin_of_safety_pct, risk, valuation,
    degraded_agents, event_flags,
    asset_light: valuation?.asset_light,
    value_trap: risk?.mispricing_type === 'value_trap',
  };
  let verdict = verdictGates(total, ctx);
  let confidence = confidencePct({ fm, business, valuation, risk, sec, event_flags, degraded_agents, ds });

  // 4.5 self-critique (только при высокой уверенности; результат LLM передаётся снаружи)
  if (self_critique && confidence >= 80) {
    const adj = clamp(Number(self_critique.confidence_adjustment) || 0, -20, 5);
    confidence = clamp(confidence + adj, 20, 90);
    if (self_critique.final_assessment === 'strong_caution') confidence = clamp(confidence - 10, 20, 90);
  }
  if (verdict === 'No Decision') confidence = Math.min(confidence, 35);

  // связь скора и уверенности: высокая оценка не бывает при низкой уверенности
  total = Math.min(total, 40 + 0.6 * confidence);

  total = +clamp(total, 0, 100).toFixed(1);

  // вердикт мог стать мягче после капа скора — переразрешаем гейты
  verdict = verdictGates(total, ctx);
  if (verdict === 'No Decision') confidence = Math.min(confidence, 35);

  const mispricing_type = reconcileMispricing(risk?.mispricing_type, verdict);

  return {
    total_score: total,
    verdict,
    confidence_pct: Math.round(confidence),
    time_horizon: risk?.time_horizon && risk.time_horizon !== 'unknown' ? risk.time_horizon : '3-5 years',
    component_scores: comps,
    sector_weights: w,
    sec_adjustment: secMod,
    mispricing_type,
    self_critique: self_critique || null,
  };
}

module.exports = {
  decide, componentScores, secModifiers, verdictGates, confidencePct,
  computeEventFlags, reconcileMispricing, SECTOR_WEIGHTS,
};
