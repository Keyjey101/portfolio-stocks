// LLM-агенты оценки (спека 05): обёртки над src/llm.js chat() с промптами из
// src/prompts.js, sanity-цепочками и фоллбеками. Правила (§5.7):
//  — числовые поля LLM никогда не переопределяют детерминированные;
//  — отказ агента ≠ отказ анализа: фоллбек-объект + _fallback:true,
//    оркестратор считает degraded;
//  — нарратив оценки падает без _fallback (математика уже готова).

const { PROMPTS } = require('../prompts');
const llmClient = require('../llm');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const i01 = (v, dflt = 0.5) => (Number.isFinite(+v) ? clamp(+v, 0, 1) : dflt);
const i010 = (v, dflt = 5) => Math.round(clamp(Number.isFinite(+v) ? +v : dflt, 0, 10));
const strs = (v, n = 5) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, n) : []);

// подстановка привязки времени в системный промпт (§5.1)
function sys(name, llm) {
  const y = new Date().getFullYear();
  return String(PROMPTS[name].system)
    .replace(/\{YEAR\}/g, y)
    .replace(/\{YEAR_M1\}/g, y - 1);
}

async function call(name, userArgs, schema, { llm = null, temperature = 0.2, task, t } = {}) {
  const impl = llm || llmClient;
  return impl.chat(
    [{ role: 'system', content: sys(name) }, { role: 'user', content: PROMPTS[name].user(userArgs) }],
    { schema, task: task || name, t, temperature },
  );
}

// ── Business (§5.3) ──
function businessFallback() {
  return {
    business_model: 'Анализ временно недоступен.',
    revenue_type: 'unknown', moat_type: 'unknown', moat_description: 'Анализ временно недоступен.',
    moat_score: 5, industry_trend: 'unknown', industry_cyclicality: 'unknown',
    industry_score: 5, business_score: 5, key_insights: [], concerns: [],
    _fallback: true,
  };
}
async function businessAgent(ds, fm, { llm } = {}) {
  try {
    const out = await call('equityBusiness', { ds, fm }, {
      business_model: 'string', revenue_type: 'string', moat_type: 'string', moat_description: 'string',
      moat_score: 'number', industry_trend: 'string', industry_cyclicality: 'string',
      industry_score: 'number', business_score: 'number', key_insights: 'array', concerns: 'array',
    }, { llm, temperature: 0.7, task: 'eqBusiness', t: ds.meta.ticker });
    return {
      ...out,
      moat_score: i010(out.moat_score), industry_score: i010(out.industry_score),
      business_score: i010(out.business_score),
      key_insights: strs(out.key_insights, 4), concerns: strs(out.concerns, 3),
      _fallback: false,
    };
  } catch (e) {
    // 1 retry на уровне оркестратора не делаем: chat() уже ретраит внутри
    return { ...businessFallback(), _error: e.message };
  }
}

// ── Valuation-нарратив (§5.4): фоллбек БЕЗ _fallback ──
function valuationFallback(ds, val) {
  const p = ds.meta?.current_price ?? null;
  const dir = val.margin_of_safety_pct > 15 ? 'недооценена относительно консенсуса методов'
    : val.margin_of_safety_pct < -15 ? 'переоценена относительно консенсуса методов'
      : 'оценена около справедливого уровня';
  return {
    relative_assessment: `Мультипликаторы: P/E ${ds.multiples?.pe_trailing ?? '?'}, EV/EBITDA ${ds.multiples?.ev_ebitda ?? '?'}.`,
    valuation_narrative: `Мульти-методная модель даёт базовую справедливую стоимость $${val.base} против цены $${p} (MoS ${val.margin_of_safety_pct}%): бумага ${dir}. Диапазон сценариев $${val.bear}–$${val.bull}.`,
    dcf_assumptions: val.assumptions,
    is_cyclically_adjusted: !!val.is_cyclically_adjusted,
  };
}
async function valuationNarrative(ds, fm, val, business, { llm } = {}) {
  try {
    const out = await call('equityValuation', { ds, val, business, fm }, {
      relative_assessment: 'string', valuation_narrative: 'string',
      dcf_assumptions: 'string', is_cyclically_adjusted: 'boolean',
    }, { llm, temperature: 0.7, task: 'eqValuation', t: ds.meta.ticker });
    return {
      relative_assessment: String(out.relative_assessment || ''),
      valuation_narrative: String(out.valuation_narrative || ''),
      dcf_assumptions: String(out.dcf_assumptions || val.assumptions),
      is_cyclically_adjusted: !!out.is_cyclically_adjusted || !!val.is_cyclically_adjusted,
    };
  } catch {
    return valuationFallback(ds, val);
  }
}

// ── Risk (§5.5) ──
function riskFallback() {
  return {
    why_cheap_or_expensive: 'Анализ временно недоступен.',
    is_temporary_or_structural: 'fairly_valued', what_market_misses: '',
    mispricing_type: 'fairly_valued', catalysts: [], key_risks: [],
    time_horizon: 'unknown', thesis_summary: '', risk_score: 5,
    sec_filing_assessment: '', sentiment_interpretation: '',
    _fallback: true,
  };
}
async function riskAgent(ctx, { llm } = {}) {
  try {
    const out = await call('equityRisk', ctx, {
      why_cheap_or_expensive: 'string', is_temporary_or_structural: 'string',
      what_market_misses: 'string', mispricing_type: 'string', catalysts: 'array',
      key_risks: 'array', time_horizon: 'string', thesis_summary: 'string',
      risk_score: 'number', sec_filing_assessment: 'string', sentiment_interpretation: 'string',
    }, { llm, temperature: 0.7, task: 'eqRisk', t: ctx.ds.meta.ticker });
    const mp = ['opportunity', 'value_trap', 'fairly_valued', 'overvalued_justified', 'overvalued_bubble'].includes(out.mispricing_type)
      ? out.mispricing_type : 'fairly_valued';
    return {
      ...out, mispricing_type: mp,
      risk_score: Math.round(clamp(+out.risk_score || 5, 0, 10)),
      catalysts: strs(out.catalysts, 4), key_risks: strs(out.key_risks, 4),
      _fallback: false,
    };
  } catch (e) {
    return { ...riskFallback(), _error: e.message };
  }
}

// ── News radar (§5.6) ──
async function newsRadar(t, name, hits, { llm } = {}) {
  const out = await call('equityNews', { t, name, hits }, {
    risk_level: 'string', events: 'array', summary: 'string',
  }, { llm, temperature: 0.2, task: 'eqNews', t });
  const lvl = ['none', 'watch', 'elevated', 'severe', 'unknown'].includes(out.risk_level) ? out.risk_level : 'unknown';
  const events = (Array.isArray(out.events) ? out.events : []).slice(0, 5).map(e => ({
    type: ['fraud', 'litigation', 'regulatory', 'short_seller', 'guidance', 'accounting', 'management', 'other'].includes(e.type) ? e.type : 'other',
    headline: String(e.headline || '').slice(0, 300),
    date: /^\d{4}-\d{2}-\d{2}/.test(String(e.date)) ? String(e.date).slice(0, 10) : null,
    summary: e.summary ? String(e.summary).slice(0, 500) : null,
  })).filter(e => e.headline);
  return {
    risk_level: lvl, events,
    summary: out.summary ? String(out.summary).slice(0, 1000) : null,
  };
}

// ── 10-K MD&A (§5.6) ──
async function mdaSummary(mda, risks, { llm } = {}) {
  const out = await call('equityMda', { mda, risks }, {
    mda_summary: 'string', top_risks: 'array', filing_tone: 'string',
  }, { llm, temperature: 0.1, task: 'eqMda' });
  const tone = ['positive', 'cautiously_optimistic', 'neutral', 'cautious', 'negative'].includes(out.filing_tone)
    ? out.filing_tone : 'neutral';
  return {
    mda_summary: String(out.mda_summary || '').slice(0, 2000),
    top_risks: strs(out.top_risks, 5),
    filing_tone: tone,
  };
}

// ── Self-critique (04 §4.5) ──
async function selfCritique(ctx, { llm } = {}) {
  try {
    const out = await call('equityCritique', ctx, {
      bear_case: 'string', confidence_adjustment: 'number',
      missed_risks: 'array', final_assessment: 'string',
    }, { llm, temperature: 0.3, task: 'eqCritique', t: ctx.t });
    return {
      bear_case: String(out.bear_case || '').slice(0, 1500),
      confidence_adjustment: Math.round(clamp(+out.confidence_adjustment || 0, -20, 5)),
      missed_risks: strs(out.missed_risks, 3),
      final_assessment: ['proceed', 'caution', 'strong_caution'].includes(out.final_assessment) ? out.final_assessment : 'proceed',
    };
  } catch {
    return { bear_case: '', confidence_adjustment: 0, missed_risks: [], final_assessment: 'proceed', _fallback: true };
  }
}

// ── Сканер-советник (06 §6.9) ──
async function advisor(rows, scanType, clusterText, { llm } = {}) {
  try {
    const out = await call('equityAdvisor', { rows, scanType, cluster: clusterText }, {
      summary: 'string',
    }, { llm, temperature: 0.7, task: 'eqAdvisor' });
    return String(out.summary || '');
  } catch {
    return '';
  }
}

// ── Дивидендные агенты (04 §4.9) ──
async function divQuality(ds, fm, { llm } = {}) {
  try {
    const out = await call('divQuality', { ds, fm }, {
      dividend_type: 'string', dividend_safety: 'number', growth_sustainability: 'number', notes: 'string',
    }, { llm, temperature: 0.7, task: 'divQuality', t: ds.meta.ticker });
    return {
      dividend_type: out.dividend_type, dividend_safety: i010(out.dividend_safety),
      growth_sustainability: i010(out.growth_sustainability), notes: String(out.notes || ''),
      _fallback: false,
    };
  } catch {
    return { dividend_type: 'none', dividend_safety: 5, growth_sustainability: 5, notes: 'Анализ временно недоступен.', _fallback: true };
  }
}
async function divRisk(ds, fm, quality, { llm } = {}) {
  try {
    const out = await call('divRisk', { ds, fm, quality }, {
      cut_risk_pct: 'number', yield_trap_probability: 'number',
      primary_risk_type: 'string', rationale: 'string',
    }, { llm, temperature: 0.7, task: 'divRisk', t: ds.meta.ticker });
    return {
      cut_risk_pct: Math.round(clamp(+out.cut_risk_pct || 0, 0, 100)),
      yield_trap_probability: Math.round(clamp(+out.yield_trap_probability || 0, 0, 100)),
      primary_risk_type: String(out.primary_risk_type || ''),
      rationale: String(out.rationale || ''),
      _fallback: false,
    };
  } catch {
    return { cut_risk_pct: 50, yield_trap_probability: 50, primary_risk_type: 'неизвестен', rationale: 'Анализ временно недоступен.', _fallback: true };
  }
}
async function divValuation(ds, fm, { llm } = {}) {
  try {
    const out = await call('divValuation', { ds, fm }, {
      yield_on_cost_3y: 'number', yield_on_cost_5y: 'number',
      expected_dps_growth_rate: 'number', total_return_estimate: 'number', rationale: 'string',
    }, { llm, temperature: 0.7, task: 'divValuation', t: ds.meta.ticker });
    return {
      yield_on_cost_3y: +i01(out.yield_on_cost_3y).toFixed(4),
      yield_on_cost_5y: +i01(out.yield_on_cost_5y).toFixed(4),
      expected_dps_growth_rate: +clamp(+out.expected_dps_growth_rate || 0, -0.5, 0.3).toFixed(4),
      total_return_estimate: +clamp(+out.total_return_estimate || 0, -0.5, 1.0).toFixed(4),
      rationale: String(out.rationale || ''),
      _fallback: false,
    };
  } catch {
    const y = ds.dividend_data?.yield || 0;
    return { yield_on_cost_3y: +y.toFixed(4), yield_on_cost_5y: +y.toFixed(4), expected_dps_growth_rate: 0, total_return_estimate: +y.toFixed(4), rationale: 'Анализ временно недоступен.', _fallback: true };
  }
}
async function divPortfolio(ds, fm, quality, risk, valuation, { llm } = {}) {
  try {
    const out = await call('divPortfolio', { ds, fm, quality, risk, valuation }, {
      portfolio_role: 'string', suggested_allocation_pct: 'number', allocation_rationale: 'string',
    }, { llm, temperature: 0.7, task: 'divPortfolio', t: ds.meta.ticker });
    return {
      portfolio_role: ['core_income', 'supplemental_income', 'growth_income', 'turnaround_speculation', 'avoid'].includes(out.portfolio_role) ? out.portfolio_role : 'supplemental_income',
      suggested_allocation_pct: Math.round(clamp(+out.suggested_allocation_pct || 0, 0, 10)),
      allocation_rationale: String(out.allocation_rationale || ''),
      _fallback: false,
    };
  } catch {
    return { portfolio_role: 'supplemental_income', suggested_allocation_pct: 0, allocation_rationale: 'Анализ временно недоступен.', _fallback: true };
  }
}

module.exports = {
  businessAgent, valuationNarrative, riskAgent, newsRadar, mdaSummary,
  selfCritique, advisor, divQuality, divRisk, divValuation, divPortfolio,
  businessFallback, riskFallback, valuationFallback,
};
