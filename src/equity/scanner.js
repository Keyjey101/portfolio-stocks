// Секторный сканер (спека 06): undervalued (прескрин → обогащение → новости →
// советник) и dividend (одна фаза по quick-данным). Задача живёт в реестре
// (Map) + персистится в data/scans/<id>.json; прогресс обновляется в БД-файле,
// фронтенд поллит /status. Кэш результата 30 мин по параметрам (08 §8.3).

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { readCache, writeCache } = require('../cache');
const dataAgent = require('./data');
const { computeMetrics } = require('./financial');
const intrinsic = require('./intrinsic');
const agents = require('./agents');
const { fetchNegativeNews } = require('./newsradar');
const { universe: universeOf, SECTORS } = require('./universe');
const { riskFreeRate } = require('./orchestrator');

const DAY = 864e5;
const SCAN_TTL = 30 * 60e3;
const SCANS_DIR = path.join(__dirname, '..', '..', 'data', 'scans');
const CLEAN_OLDER = 7 * DAY;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── фильтры (06 §6.3) ──
const CAP_MIN = { all: 0, micro: 300e6, mid: 2e9, large: 10e9 };
const VOL_MIN = { all: 0, low: 100e3, medium: 500e3, high: 1e6 };

function normParams(p = {}) {
  return {
    topN: [10, 20, 30, 50].includes(+p.topN) ? +p.topN : 20,
    scanType: p.scanType === 'dividend' ? 'dividend' : 'undervalued',
    sector: p.sector && SECTORS.includes(p.sector) ? p.sector : null,
    marketCapTier: ['all', 'micro', 'mid', 'large'].includes(p.marketCapTier) ? p.marketCapTier : 'all',
    volumeTier: ['all', 'low', 'medium', 'high'].includes(p.volumeTier) ? p.volumeTier : 'all',
    stockList: null, // единая курируемая вселенная; Russell-снимок не ведём
  };
}

const scanCacheKey = p => 'eq-scan-' + crypto.createHash('sha256')
  .update('scanner:' + JSON.stringify(p, Object.keys(p).sort())).digest('hex').slice(0, 24);

// ── реестр задач ──
const tasks = new Map(); // id → task

function persist(task) {
  try {
    fs.mkdirSync(SCANS_DIR, { recursive: true });
    const f = path.join(SCANS_DIR, task.id + '.json');
    if (task.status === 'completed' || task.status === 'failed') {
      // храним компактно: без пейлоада шагов
      fs.writeFileSync(f, JSON.stringify({ ...task }));
    } else {
      fs.writeFileSync(f, JSON.stringify({ ...task }));
    }
  } catch { /* персист не критичен */ }
}

function loadTask(id) {
  if (tasks.has(id)) return tasks.get(id);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SCANS_DIR, id + '.json'), 'utf8'));
    tasks.set(id, j);
    return j;
  } catch { return null; }
}

// уборка старых сканов (09 §9.3) — при каждом старте нового
function cleanupScans() {
  try {
    for (const f of fs.readdirSync(SCANS_DIR)) {
      const p = path.join(SCANS_DIR, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > CLEAN_OLDER) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

// ── прескрин-скор (06 §6.4): база 50, clamp 0–100 ──
function prescreenScore(q, scanType) {
  let s = 50;
  if (scanType === 'undervalued') {
    const pe = q.pe_trailing;
    if (pe == null) s -= 5;
    else if (pe < 0) s -= 5;
    else if (pe < 5) s -= 5;
    else if (pe < 12) s += 18;
    else if (pe < 18) s += 10;
    else if (pe < 25) s += 4;
    else if (pe < 40) s -= 5;
    else if (pe < 60) s -= 12;
    else s -= 20;
    const fr = q.pe_forward, tr = q.pe_trailing;
    if (fr != null && tr > 0) {
      const r = fr / tr;
      if (r > 1.3) s -= 12;
      else if (r > 1.1) s -= 6;
      else if (r < 0.85) s += 8;
      else if (r < 0.95) s += 4;
    }
    const pb = q.pb;
    if (pb != null && pb > 0 && pb < 1.5) s += 10;
    else if (pb != null && pb > 0 && pb < 3) s += 4;
    const roe = q.roe;
    if (roe != null) {
      if (roe > 0.20) s += 12;
      else if (roe > 0.12) s += 7;
      else if (roe < 0) s -= 12;
    }
    const rg = q.revenue_growth;
    if (rg != null) {
      if (rg > 0.15) s += 10;
      else if (rg > 0.05) s += 5;
      else if (rg < -0.05) s -= 8;
    }
    const m = q.profit_margin;
    if (m != null) {
      if (m > 0.15) s += 8;
      else if (m > 0.05) s += 4;
      else if (m < 0) s -= 10;
    }
    if (q.beta != null && q.beta >= 0.5 && q.beta <= 1.3) s += 3;
  } else {
    const y = q.dividend_yield;
    if (y != null) {
      if (y >= 0.025 && y < 0.06) s += 22;
      else if (y >= 0.06 && y < 0.09) s += 12;
      else if (y >= 0.12) s -= 8;
    }
    const pr = q.payout_ratio;
    if (pr != null) {
      if (pr >= 0.15 && pr <= 0.55) s += 15;
      else if (pr <= 0.75) s += 6;
      else if (pr > 0.90) s -= 12;
    }
    const roe = q.roe;
    if (roe != null) {
      if (roe > 0.15) s += 10;
      else if (roe > 0.08) s += 5;
      else if (roe < 0) s -= 10;
    }
    const m = q.profit_margin;
    if (m != null) {
      if (m > 0.12) s += 8;
      else if (m > 0) s += 3;
    }
    if (q.beta != null && q.beta < 0.9) s += 5;
  }
  return clamp(Math.round(s), 0, 100);
}

// жёсткие условия фильтра (06 §6.3)
function passesFilter(q, p) {
  if (!q || !q.current_price || !q.market_cap) return false;
  if ((q.market_cap || 0) < CAP_MIN[p.marketCapTier]) return false;
  if ((q.avg_volume || 0) < VOL_MIN[p.volumeTier]) return false;
  if (p.sector && q.sector !== p.sector) return false;
  if (p.scanType === 'undervalued' && !(q.pe_trailing != null && q.pe_trailing > 0 && q.pe_trailing <= 80)) return false;
  if (p.scanType === 'dividend' && !((q.dividend_yield ?? 0) >= 0.005 && (q.payout_ratio ?? 1) <= 1.5)) return false;
  return true;
}

// вердикт скана по MoS (06 §6.5 п.5)
function scanVerdict(mos) {
  if (mos > 30) return 'STRONGLY UNDERVALUED';
  if (mos > 15) return 'MODERATELY UNDERVALUED';
  if (mos > -10) return 'FAIRLY VALUED';
  if (mos > -25) return 'MODERATELY OVERVALUED';
  return 'STRONGLY OVERVALUED';
}

// ── качество сектора (06 §6.5 п.6–7) ──
function sectorQuality(row, fm, business) {
  const kw = /bank|insur|capital markets|mortgage/i.test(String(row.industry || ''));
  let q;
  if (kw) {
    const roe = fm.avg_roe ?? 0;
    let rule = 5.0;
    if (roe >= 0.15) rule += 2.5; else if (roe >= 0.10) rule += 1.0;
    if (roe < 0.05) rule -= 1.5;
    if (roe < 0) rule -= 2.5;
    q = 0.6 * rule + 0.4 * (business?.business_score ?? 5);
  } else {
    q = business?.business_score ?? fm.financial_strength_score;
    if ((fm.avg_roic ?? 0) < 0) q = Math.min(q, 4.0);
    if ((fm.avg_roic ?? 0) >= 0.20 && (fm.avg_operating_margin ?? 0) > 0.40) q = Math.max(q, 7.0);
  }
  return clamp(+q.toFixed(1), 0, 10);
}

// пик маржи (06 §6.5 п.7)
function peakMarginFlag(ds, fm) {
  const om = (ds.derived?.operating_margin || []).filter(v => Number.isFinite(v)).slice(0, 8);
  if (om.length < 5 || !fm.is_cyclical) return false;
  const mean = om.reduce((s, x) => s + x, 0) / om.length;
  const sd = Math.sqrt(om.reduce((s, x) => s + (x - mean) ** 2, 0) / om.length);
  return sd > 0 && om[0] >= mean + 1.5 * sd;
}

// ── red flags (06 §6.5 п.9; финансы пропускают FCF/Piotroski/левередж) ──
function redFlags(row, fm, ds) {
  const items = [];
  let critical = 0, warnings = 0;
  const fin = /bank|insur|capital markets|mortgage/i.test(String(row.industry || ''));
  const d = ds.derived;
  const add = (sev, text) => {
    items.push(text);
    if (sev === 'crit') critical++; else warnings++;
  };
  if (!fin) {
    const fcf0 = d.free_cash_flow?.[0];
    if (fcf0 != null && fcf0 < 0) { add('crit', 'Отрицательный FCF'); add('crit', 'FCF < 0 (двойной вес)'); }
    if (fm.revenue_trend === 'declining' && fm.margin_trend === 'declining') add('warn', 'Падают и выручка, и маржа');
    const ndEbitda = d.net_debt?.[0] != null && d.ebitda?.[0] > 0 ? d.net_debt[0] / d.ebitda[0] : null;
    if (ndEbitda != null && ndEbitda > 4) add('crit', `NetDebt/EBITDA ${ndEbitda.toFixed(1)} (критично)`);
    else if (ndEbitda != null && ndEbitda > 3) add('warn', `NetDebt/EBITDA ${ndEbitda.toFixed(1)}`);
    const ic = fm.avg_interest_coverage;
    if (ic != null && ic < 2) add('crit', `Покрытие процентов ${ic.toFixed(1)}× (критично)`);
    else if (ic != null && ic < 3) add('warn', `Покрытие процентов ${ic.toFixed(1)}×`);
    if (fm.piotroski_f <= 3) add('crit', `Piotroski ${fm.piotroski_f}/7 (критично)`);
    else if (fm.piotroski_f <= 5) add('warn', `Piotroski ${fm.piotroski_f}/7`);
  }
  const roe = fm.avg_roe;
  const gaapDistorted = fm.eps_quality_flag === 'likely_one_time_gain' && (fm.forward_eps ?? 0) > 0;
  if (roe != null && roe < 0) gaapDistorted ? add('warn', 'ROE < 0 при положительном fwd EPS (GAAP искажён)') : add('crit', 'ROE < 0');
  else if (roe != null && roe < 0.05) add('warn', 'ROE < 5%');
  if ((fm.avg_roic ?? 1) < 0) add('warn', 'ROIC < 0');
  if ((ds.dividend_data?.payout_ratio ?? 0) > 0.90) add('warn', 'Payout > 90%');
  if (fm.growth_score <= 2) add('warn', 'Скор роста ≤ 2/10');
  if (fm.is_cyclical && fm.margin_trend === 'declining') add('warn', 'Цикличная компания с падающими маржами');
  return { critical, warnings, items: items.slice(0, 15) };
}

// ── санити-цепочка вердикта (06 §6.5 п.8) ──
function sanityChain(row, val, ds, fm) {
  const price = row.current_price;
  let dcfBase = val.dcf_base;
  // LLM-числа вне [5%, 1500%] цены → формульная FV (здесь LLM в числах не участвует,
  // гард остаётся на случай будущих расширений)
  if (!(dcfBase >= 0.05 * price && dcfBase <= 15 * price)) dcfBase = val.methods.length ? val.base : price;
  // якорь консенсуса
  const tm = ds.analyst?.target_mean;
  if (tm > 0) dcfBase = Math.min(dcfBase, tm * 1.25, ds.analyst?.target_high ?? Infinity, price * 1.6);
  // потолок собственного мультипликатора
  const g = val.growth_used;
  let peCap = g <= 0 ? 14 : g < 0.05 ? 17 : g < 0.10 ? 20 : g < 0.15 ? 24 : g < 0.20 ? 28 : 30;
  const qualityAdj = (row.sector_quality >= 8 ? 2 : row.sector_quality < 5 ? -2 : 0);
  peCap = clamp(peCap + qualityAdj, 10, 32);
  const epsF = fm.forward_eps ?? fm.trailing_eps;
  if (epsF > 0 && (ds.multiples?.pe_forward ?? Infinity) <= peCap) {
    dcfBase = Math.min(dcfBase, peCap * epsF);
  } else if (epsF > 0) {
    // «никогда ниже текущего P/E» — если текущий P/E выше потолка, потолок не применяется
  }
  const mos = Math.round(((dcfBase - price) / price) * 1000) / 10;
  const score = intrinsic.marginOfSafetyScore(mos);
  let fair_value_review = false, fair_value_review_reason = null;
  let extreme_gap_warning = false, extreme_gap_reason = null;
  if (mos > 50) {
    if (row.sector_quality >= 7) {
      fair_value_review = true;
      fair_value_review_reason = 'Экстремальный разрыв при высоком качестве — оценка требует ревью';
      val.valuation_score = Math.min(val.valuation_score, 7);
    } else {
      const cleanPio = fm.piotroski_f >= 7 || (fm.avg_roic ?? 0) >= 0.10;
      const trendsOk = fm.revenue_trend !== 'declining' && fm.margin_trend !== 'declining';
      const epsClean = ['normal', 'expected_growth'].includes(fm.eps_quality_flag);
      if (!(cleanPio && trendsOk && epsClean)) {
        extreme_gap_warning = true;
        extreme_gap_reason = 'Экстремальная дешевизна без подтверждения качеством — вероятен value trap';
        val.valuation_score = Math.min(val.valuation_score, 6);
      }
    }
  }
  return { dcfBase, mos, score, verdict: scanVerdict(mos), fair_value_review, fair_value_review_reason, extreme_gap_warning, extreme_gap_reason };
}

// ── поправки качества к прескрин-скору (06 §6.5 п.10) ──
function qualityAdjust(row, fm, mos) {
  const reasons = [];
  let total = row.prescreen_score;
  const q = row.sector_quality;
  const fin = /bank|insur|capital markets|mortgage/i.test(String(row.industry || ''));
  if (q < 6 && fm.revenue_trend === 'declining') { total -= 25; reasons.push('качество < 6 при падающей выручке −25'); }
  if (q <= 3) { total -= 12; reasons.push('качество ≤ 3 −12'); }
  if (!fin && (fm.avg_roic ?? 1) < 0.10 && fm.revenue_trend === 'declining') { total -= 15; reasons.push('ROIC < 10% + падающая выручка −15'); }
  if (fm.is_highly_cyclical && fm.margin_trend === 'declining') { total -= 12; reasons.push('высокоцикличная + падающие маржи −12'); }
  else if (fm.is_cyclical && fm.margin_trend === 'declining') { total -= 8; reasons.push('цикличная деградация маржи −8'); }
  if (row.peak_margin_flag) { total -= 12; reasons.push('цикличная на пике маржи −12'); }
  if (q >= 8 && mos > 15 && row.red_flags.critical === 0 && row.red_flags.warnings <= 1) {
    total += 10; reasons.push('качество ≥ 8 со скидкой — чисто +10');
  }
  return { total: clamp(Math.round(total), 0, 100), reasons };
}

// ── value-trap (06 §6.5 п.11) ──
function valueTrapCheck(mos, fm, row) {
  if (!(mos > 30)) return { warning: false, reason: null };
  const cond =
    (fm.is_highly_cyclical && fm.margin_trend === 'declining')
    || (fm.revenue_trend === 'declining' && fm.piotroski_f <= 3)
    || row.red_flags.critical >= 3
    || row.extreme_gap_warning;
  if (cond) return { warning: true, reason: 'Дёшево из-за деградации: цикл/маржи/Piotroski/red flags не подтверждают недооценку' };
  return { warning: false, reason: null };
}

// ── постфильтр и ранжирование (06 §6.7) ──
function postfilterAndRank(rows, topN) {
  let pool = rows;
  const strong = pool.filter(r => r.valuation.marginOfSafety > 5);
  if (strong.length >= Math.min(Math.floor(topN / 2), 5)) pool = strong;
  else {
    const mild = pool.filter(r => r.valuation.marginOfSafety > -5);
    if (mild.length >= Math.min(Math.floor(topN / 4), 3)) pool = mild;
  }
  for (const r of pool) {
    const combined = r.total_score * 0.40 + (r.valuation_score / 9) * 100 * 0.60;
    r.combined = combined;
    r.scan_score = +clamp(0, 99.9,
      combined * 0.92
      + clamp(r.valuation.marginOfSafety * 0.03, -2, 2)
      + clamp((r.avg_roic ?? 0) * 100 * 0.03, 0, 1.5)
      + clamp((r.fcf_yield ?? 0) * 100 * 0.15, 0, 1.5),
    ).toFixed(1);
  }
  pool.sort((a, b) => b.scan_score - a.scan_score);
  return pool.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

// ── кластерное предупреждение (06 §6.9) ──
function clusterWarning(rows) {
  if (rows.length < 6) return null;
  const bySector = {};
  for (const r of rows) bySector[r.sector] = (bySector[r.sector] || 0) + 1;
  const top = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  if (top[0][1] >= Math.max(4, Math.ceil(rows.length * 0.4))) {
    return `в выдаче ≥40% из сектора «${top[0][0]}» — это одна ставка, а не несколько`;
  }
  if (top.length >= 2 && top[0][1] + top[1][1] >= rows.length * 0.55) {
    return `топ-2 сектора (${top[0][0]}, ${top[1][0]}) покрывают ≥55% выдачи — концентрация риска`;
  }
  const badNews = rows.filter(r => ['elevated', 'severe'].includes(r.news_radar?.level)).length;
  if (badNews >= Math.max(3, Math.ceil(rows.length * 0.3))) {
    return `у ≥30% строк повышенный новостной риск — проверь, не общий ли это фактор`;
  }
  return null;
}

// пул с ограничением параллельности
async function pool(items, fn, size) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

// внутренние строки snake_case → camelCase-контракт внешнего API (08 §8.3)
function toUiRow(r) {
  return {
    rank: r.rank, ticker: r.ticker, name: r.name, sector: r.sector, industry: r.industry,
    currentPrice: r.current_price, marketCap: r.market_cap,
    drawdownFrom52wHigh: r.drawdown_from_52w_high,
    totalScore: r.total_score, prescreenScore: r.prescreen_score,
    sectorQuality: r.sector_quality ?? null,
    qualityAdjReasons: r.quality_adj_reasons || [],
    peakMarginFlag: !!r.peak_margin_flag,
    valuation: r.valuation,
    scores: { scanScore: r.scan_score ?? r.total_score ?? null, qualityScore: r.sector_quality ?? null },
    businessScore: r.business_score ?? null, moatType: r.moat_type ?? null, moatScore: r.moat_score ?? null,
    keyMetrics: r.keyMetrics || {
      peTrailing: r.pe_trailing ?? null, evEbitda: r.ev_ebitda ?? null, roic: r.avg_roic ?? null,
      revenueCAGR3yr: r.revenue_cagr_3y ?? null, fcfYield: r.fcf_yield ?? null, netDebtEbitda: null,
    },
    piotroskiF: r.piotroski_f ?? null,
    peForward: r.pe_forward ?? null, pb: r.pb ?? null, roe: r.roe ?? null,
    revenueGrowth: r.revenue_growth ?? null, beta: r.beta ?? null,
    avgRoic: r.avg_roic ?? null, avgOperatingMargin: r.avg_operating_margin ?? null,
    cyclicalityTag: r.cyclicality_tag ?? null,
    financialStrengthScore: r.financial_strength_score ?? null,
    dividendYield: r.dividend_yield ?? null, payoutRatio: r.payout_ratio ?? null,
    valuationNarrative: r.valuation_narrative || null,
    extremeGapWarning: !!r.extreme_gap_warning, extremeGapReason: r.extreme_gap_reason || null,
    fairValueReview: !!r.fair_value_review, fairValueReviewReason: r.fair_value_review_reason || null,
    valueTrapWarning: !!r.value_trap_warning, valueTrapReason: r.value_trap_reason || null,
    newsQuarantine: !!r.news_quarantine, newsCaution: !!r.news_caution, unexplainedMove: !!r.unexplained_move,
    redFlags: r.redFlags || r.red_flags || { critical: 0, warnings: 0, items: [] },
    valueTrap: r.valueTrap || { warning: !!r.value_trap_warning, reason: r.value_trap_reason || null },
    newsRadar: r.newsRadar || r.news_radar || { level: 'none', summary: null, items: [] },
  };
}

// ── статистика (улучшение 10 §6: считаем строки *_UNDERVALUED) ──
const stats = (rows, topN, failed) => ({
  analyzed: rows.length,
  undervalued: rows.filter(r => String(r.valuation?.verdict || '').includes('UNDERVALUED')).length,
  returnedTopN: topN, failed,
});

// ── запуск скана: возвращает id задачи (создаётся ДО старта — поллинг без 404) ──
function startScan(rawParams, { fetchImpl = fetch, llm = null } = {}) {
  const params = normParams(rawParams);
  const cacheName = scanCacheKey(params);
  if (!rawParams.force) {
    const c = readCache(cacheName, SCAN_TTL);
    if (c) return { scanId: 'cache_' + cacheName, cached: true, estimatedSeconds: 0, params };
  }
  cleanupScans();
  const id = crypto.randomUUID().slice(0, 8);
  const task = {
    id, scan_type: params.scanType, status: 'running', params,
    progress: { universeSize: 0, fetched: 0, prescreened: 0, total: 0, analyzed: 0, failed: 0, phase: 'prescreening' },
    results: null, advisor: null, error_message: null,
    created_at: Date.now(), completed_at: null,
  };
  tasks.set(id, task);
  persist(task);
  console.error(`[scan ${id}] запуск: ${params.scanType} · сектор ${params.sector || 'все'} · cap ${params.marketCapTier} · объём ${params.volumeTier} · topN ${params.topN}`);
  const estimated = params.scanType === 'undervalued' ? params.topN * 30 : 120;
  runScan(task, { fetchImpl, llm }).catch(e => {
    task.status = 'failed';
    task.error_message = e.message;
    persist(task);
  });
  return { scanId: id, cached: false, estimatedSeconds: estimated, params };
}

// фаза скана с логом в stderr (наблюдаемость, 10 §9)
function setPhase(task, name) {
  task.progress.phase = name;
  console.error(`[scan ${task.id}] фаза: ${name} · fetched ${task.progress.fetched}/${task.progress.universeSize} · фильтр ${task.progress.prescreened} · глубоко ${task.progress.analyzed}/${task.progress.total || '?'} · ошибок ${task.progress.failed}`);
  persist(task);
}

// ── сам скан ──
async function runScan(task, { fetchImpl, llm }) {
  const p = task.params;
  const list = universeOf(p.sector);
  task.progress.universeSize = list.length;

  // фаза 1: прескрин по quick-данным (кэш 12 ч делает повторные сканы быстрыми)
  let checked = 0;
  const quicks = await pool(list, async t => {
    const q = await dataAgent.fetchQuick(t, { fetchImpl });
    checked++;
    if (checked % 25 === 0) {
      task.progress.fetched = checked;
      persist(task);
    }
    return q;
  }, 4);
  task.progress.fetched = checked;

  const passed = [];
  for (const q of quicks) {
    if (passesFilter(q, p)) passed.push({ q, prescreen: prescreenScore(q, p.scanType) });
  }
  task.progress.prescreened = passed.length;
  passed.sort((a, b) => b.prescreen - a.prescreen);

  if (p.scanType === 'dividend') {
    // одна фаза: top-N строк из quick-info (06 §6.8)
    const rows = passed.slice(0, p.topN).map((x, i) => ({
      rank: i + 1, ticker: x.q.ticker, name: x.q.name, sector: x.q.sector, industry: x.q.industry,
      current_price: x.q.current_price, market_cap: x.q.market_cap,
      drawdown_from_52w_high: x.q['52w_high'] ? +((x.q.current_price / x.q['52w_high'] - 1) * 100).toFixed(1) : null,
      total_score: x.prescreen, prescreen_score: x.prescreen,
      dividend_yield: x.q.dividend_yield, payout_ratio: x.q.payout_ratio,
      pe_trailing: x.q.pe_trailing, pe_forward: x.q.pe_forward, pb: x.q.pb,
      roe: x.q.roe, profit_margin: x.q.profit_margin, beta: x.q.beta,
      valuation: { fairValueWeighted: null, marginOfSafety: null, verdict: 'DIVIDEND CANDIDATE' },
      scores: { scanScore: x.prescreen, qualityScore: null },
      keyMetrics: { peTrailing: x.q.pe_trailing, evEbitda: x.q.ev_ebitda, roic: null, revenueCAGR3yr: null, fcfYield: null, netDebtEbitda: null },
      redFlags: { critical: 0, warnings: 0, items: [] },
      valueTrap: { warning: (x.q.dividend_yield ?? 0) >= 0.08 && (x.q.payout_ratio ?? 0) > 0.8, reason: (x.q.dividend_yield ?? 0) >= 0.08 && (x.q.payout_ratio ?? 0) > 0.8 ? 'Высокий yield с большим payout — проверь устойчивость' : null },
      newsRadar: { level: 'none', summary: null, items: [] },
    }));
    setPhase(task, 'advisor');
    let advisorText = '';
    if (llm) advisorText = await agents.advisor(rows, 'dividend', clusterWarning(rows), { llm }).catch(() => '');
    const uiRows = rows.map(toUiRow);
    task.status = 'completed';
    task.results = uiRows;
    task.advisor = advisorText;
    task.completed_at = Date.now();
    task.progress.phase = 'done';
    writeCache(scanCacheKey(p), { results: uiRows, advisor: advisorText, stats: stats(rows, p.topN, 0) });
    persist(task);
    console.error(`[scan ${task.id}] готово (dividend): ${uiRows.length} строк · ${((Date.now() - task.created_at) / 1000).toFixed(0)}s`);
    return;
  }

  // ── фаза 2: обогащение (последовательно на тикер, 06 §6.5) ──
  const pool2 = passed.slice(0, Math.min(p.topN + 10, passed.length));
  task.progress.total = pool2.length;
  setPhase(task, 'deep_analysis');

  const enriched = [];
  let failed = 0;
  console.error(`[scan ${task.id}] глубокий анализ: ${pool2.length} тикеров`);
  for (const cand of pool2) {
    const q = cand.q;
    try {
      const ds = await dataAgent.fetchFull(q.ticker, { fetchImpl, withNews: false });
      const fm = computeMetrics(ds);
      const business = await agents.businessAgent(ds, fm, { llm });
      const val = intrinsic.compute(ds, fm, { rf: riskFreeRate() });
      const narrative = await agents.valuationNarrative(ds, fm, val, business, { llm });
      Object.assign(val, narrative);
      canonicalize(val, ds.meta.current_price);

      const row = {
        ticker: q.ticker, name: ds.meta.name || q.name, sector: ds.meta.sector || q.sector,
        industry: ds.meta.industry || q.industry, current_price: ds.meta.current_price,
        market_cap: ds.meta.market_cap,
        drawdown_from_52w_high: ds.price_hist?.drawdown_52w != null ? +(ds.price_hist.drawdown_52w * 100).toFixed(1) : null,
        prescreen_score: cand.prescreen,
        business_score: business.business_score, moat_type: business.moat_type, moat_score: business.moat_score,
        pe_trailing: ds.multiples.pe_trailing, pe_forward: ds.multiples.pe_forward, pb: ds.multiples.pb,
        ev_ebitda: ds.multiples.ev_ebitda, roe: fm.avg_roe, profit_margin: ds.quick?.profit_margin,
        revenue_growth: ds.analyst?.revenue_growth, beta: ds.meta.beta,
        avg_roic: fm.avg_roic, revenue_cagr_3y: fm.revenue_cagr_3y, revenue_cagr_5y: fm.revenue_cagr_5y,
        fcf_yield: ds.multiples.fcf_yield, avg_debt_ebitda: fm.avg_debt_ebitda,
        avg_operating_margin: fm.avg_operating_margin, piotroski_f: fm.piotroski_f,
        cyclicality_tag: fm.cyclicality_tag,
        financial_strength_score: fm.financial_strength_score,
        valuation_narrative: val.valuation_narrative,
        avg_roe: fm.avg_roe,
        // поля ниже заполняются по цепочке
        valuation: { fairValueWeighted: val.dcf_base, marginOfSafety: val.margin_of_safety_pct, verdict: scanVerdict(val.margin_of_safety_pct) },
        scores: {},
        keyMetrics: {
          peTrailing: ds.multiples.pe_trailing, evEbitda: ds.multiples.ev_ebitda, roic: fm.avg_roic,
          revenueCAGR3yr: fm.revenue_cagr_3y, fcfYield: ds.multiples.fcf_yield,
          netDebtEbitda: ds.derived.net_debt?.[0] != null && ds.derived.ebitda?.[0] > 0 ? +(ds.derived.net_debt[0] / ds.derived.ebitda[0]).toFixed(2) : null,
        },
        redFlags: null, valueTrap: { warning: false, reason: null },
        newsRadar: { level: 'none', summary: null, items: [] },
        valuation_score: val.valuation_score,
      };
      row.peak_margin_flag = peakMarginFlag(ds, fm);
      row.sector_quality = sectorQuality(row, fm, business);
      const sane = sanityChain(row, val, ds, fm);
      row.valuation = { fairValueWeighted: +sane.dcfBase.toFixed(2), marginOfSafety: sane.mos, verdict: sane.verdict };
      row.valuation_score = sane.score;
      row.extreme_gap_warning = sane.extreme_gap_warning;
      row.extreme_gap_reason = sane.extreme_gap_reason;
      row.fair_value_review = sane.fair_value_review;
      row.fair_value_review_reason = sane.fair_value_review_reason;
      row.red_flags = redFlags(row, fm, ds);
      const qa = qualityAdjust(row, fm, sane.mos);
      row.total_score = qa.total;
      row.quality_adj_reasons = qa.reasons;
      const vt = valueTrapCheck(sane.mos, fm, row);
      row.value_trap_warning = vt.warning;
      row.value_trap_reason = vt.reason;
      // UI-отражения
      row.redFlags = { critical: row.red_flags.critical, warnings: row.red_flags.warnings, items: row.red_flags.items };
      row.valueTrap = { warning: vt.warning, reason: vt.reason };
      enriched.push(row);
    } catch (e) {
      failed++;
      task.progress.failed = failed;
      console.error(`[scan ${task.id}] ${q.ticker}: ${e.message}`);
    }
    task.progress.analyzed++;
    if (task.progress.analyzed % 3 === 0) persist(task);
  }

  // ── фаза 3: news radar по обогащённому пулу (06 §6.6) ──
  setPhase(task, 'news_radar');
  let newsDone = 0;
  await pool(enriched, async row => {
    try {
      const news = await fetchNegativeNews(row.ticker, row.name, { fetchImpl, llm });
      row.news_radar = { level: news.risk_level, summary: news.summary, items: (news.events || []).slice(0, 3) };
      // демотации
      const severe = news.risk_level === 'severe' || (news.events || []).some(e => ['fraud', 'accounting', 'short_seller'].includes(e.type));
      const elevated = news.risk_level === 'elevated' || (news.events || []).some(e => e.type === 'guidance');
      if (severe) {
        row.valuation_score = Math.min(row.valuation_score, 2);
        row.total_score = Math.min(row.total_score, 45);
        row.news_quarantine = true;
        row.valuation.verdict = 'AVOID — recent material news';
      } else if (elevated) {
        row.valuation_score = Math.min(row.valuation_score, 5);
        row.total_score = Math.min(row.total_score, 65);
        row.news_caution = true;
        if (row.valuation.verdict === 'STRONGLY UNDERVALUED') row.valuation.verdict = 'MODERATELY UNDERVALUED (news caution)';
      }
      // просадка ≥30% от 52w high без новостей → unexplained_move
      if ((row.drawdown_from_52w_high ?? 0) <= -30 && news.risk_level === 'none') row.unexplained_move = true;
    } catch { /* без новостей строка остаётся */ }
    newsDone++;
    if (newsDone % 5 === 0) persist(task);
  }, 3);

  // ── постфильтр, ранжирование, статистика ──
  setPhase(task, 'ranking');
  const ranked = postfilterAndRank(enriched, p.topN);

  setPhase(task, 'advisor');
  let advisorText = '';
  if (llm && ranked.length) {
    advisorText = await agents.advisor(ranked, 'undervalued', clusterWarning(ranked), { llm }).catch(() => '');
  }

  task.status = 'completed';
  const uiRows = ranked.map(toUiRow);
  task.results = uiRows;
  task.advisor = advisorText;
  task.completed_at = Date.now();
  task.progress.phase = 'done';
  writeCache(scanCacheKey(p), { results: uiRows, advisor: advisorText, stats: stats(ranked, p.topN, failed) });
  persist(task);
  console.error(`[scan ${task.id}] готово: ${uiRows.length} строк · ошибок ${failed} · ${((Date.now() - task.created_at) / 1000).toFixed(0)}s`);
}

// канонический пересчёт MoS по dcf_base (тот же принцип, что в оркестраторе)
function canonicalize(val, price) {
  if (val.dcf_base == null || !(price > 0)) return val;
  const mos = Math.round(((val.dcf_base - price) / price) * 1000) / 10;
  val.margin_of_safety_pct = mos;
  val.valuation_score = intrinsic.marginOfSafetyScore(mos);
  return val;
}

// ── API задачи ──
function getStatus(id) {
  if (String(id).startsWith('cache_')) {
    const c = readCache(String(id).slice(6), SCAN_TTL);
    return c ? { scanId: id, status: 'completed', params: c.params || null, progress: { phase: 'done' }, error_message: null } : null;
  }
  const t = loadTask(id);
  if (!t) return null;
  return {
    scanId: t.id, status: t.status, params: t.params, progress: t.progress,
    error_message: t.error_message,
  };
}

function getResults(id) {
  const key = String(id).startsWith('cache_') ? String(id).slice(6) : (loadTask(id) && scanCacheKey(loadTask(id).params));
  const c = readCache(key, SCAN_TTL) || (loadTask(id) && { results: loadTask(id).results, advisor: loadTask(id).advisor, stats: null });
  if (!c || !c.results) return null;
  const t = String(id).startsWith('cache_') ? null : loadTask(id);
  if (t && t.status !== 'completed') return { notReady: true };
  return c;
}

module.exports = {
  startScan, getStatus, getResults, prescreenScore, passesFilter, scanVerdict,
  sectorQuality, redFlags, sanityChain, qualityAdjust, valueTrapCheck,
  postfilterAndRank, clusterWarning, normParams, scanCacheKey,
};
