// #М2 вывод уровней докупа от состояния тезиса. Уровни в META захардкожены
// и не меняются; здесь они выводятся заново при каждой смене состояния,
// после отчёта, при срабатывании фальсификации, при уходе цены >25% от
// цены вывода или вручную. Каждый вывод пишется в levels_history с basis —
// владелец видит, почему уровень такой, а не другой.
//
// Чистая математика (эталон проверки — пример ZTS из спецификации):
//   normalized_EPS = min(гайденс, консенсус), при повторном срезе −haircut;
//   fair = EPS × [multiple_low..multiple_high] (множитель сжат при damaged);
//   attractive = fair × (1 − MoS), MoS = 0.20/0.30/0.40 по числу задетых опор;
//   T1 = attractive_high, T2 = attractive_mid, T3 = attractive_low;
//   разнос уровней ≥ 0.75σ; уровень при damaged активируется ТОЛЬКО парой
//   (цена + факт подтверждения) — until_event/until_check.
const { chart } = require('../yahoo');
const { fetchHeadlines } = require('../news');
const { edgarRecent } = require('../edgar');
const { readCache } = require('../cache');
const overrides = require('../overrides');
const { PROMPTS } = require('../prompts');
const defaultLlm = require('../llm');

const MOS_BY_PILLARS = n => (n >= 3 ? 0.40 : n === 2 ? 0.30 : 0.20);
const SPACING_SIGMA = 0.75;   // минимальный разнос соседних уровней, в σ
const REDERIVE_MOVE = 0.25;   // уход цены от derived_at, запускающий перевывод

// запас прочности по числу задетых опор
const mosForDamaged = n => MOS_BY_PILLARS(Math.max(1, n | 0));

// справедливый диапазон: EPS × мультипликатор, haircut при повторном срезе гайденса
function fairRange({ eps, multLow, multHigh, haircutPct = 0 }) {
  if (!(eps > 0) || !(multLow > 0) || !(multHigh >= multLow)) return null;
  const h = Math.min(0.5, Math.max(0, haircutPct) / 100); // haircut в %, кап 50%
  const e = eps * (1 - h);
  return { low: e * multLow, high: e * multHigh, epsUsed: e };
}

// привлекательная зона с запасом за риск
function attractiveZone(fair, mos) {
  if (!fair) return null;
  const low = fair.low * (1 - mos), high = fair.high * (1 - mos);
  return { low, mid: (low + high) / 2, high, mos };
}

// разнос соседних уровней ≥ minGap (долл.): якорь — средний уровень,
// крайние раздвигаются наружу, сетка только расширяется
function enforceSpacing(lv, minGap) {
  if (!lv) return lv;
  const out = lv.map(v => (v == null ? null : +v));
  if (out.some(v => v == null) || out.length !== 3 || !(minGap > 0)) return out;
  let [t1, t2, t3] = out;
  if (t1 < t2) [t1, t2] = [t2, t1]; // нормализуем порядок T1 ≥ T2 ≥ T3
  if (t2 < t3) [t2, t3] = [t3, t2];
  if (t1 < t2) [t1, t2] = [t2, t1];
  t1 = Math.max(t1, t2 + minGap);
  t3 = Math.min(t3, t2 - minGap);
  return [Math.round(t1 * 100) / 100, Math.round(t2 * 100) / 100, Math.round(Math.max(0.01, t3) * 100) / 100];
}

// полный вывод для damaged — эталон ZTS: eps 6.90, 12–15x, 2 опоры → T1≈72 T3≈58
function deriveDamaged({ eps, multLow, multHigh, haircutPct = 0, damagedPillars = 1, sigmaUsd = null, epsBasis = '', multBasis = '' }) {
  const fair = fairRange({ eps, multLow, multHigh, haircutPct });
  if (!fair) return { error: 'нет данных для вывода: нужен EPS>0 и корректный диапазон мультипликатора' };
  const nDam = Array.isArray(damagedPillars) ? damagedPillars.length : damagedPillars;
  const mos = mosForDamaged(nDam);
  const zone = attractiveZone(fair, mos);
  const minGap = sigmaUsd != null && sigmaUsd > 0 ? SPACING_SIGMA * sigmaUsd : null;
  let lv = [zone.high, zone.mid, zone.low];
  if (minGap) lv = enforceSpacing(lv, minGap);
  const basis = [
    `база EPS $${fair.epsUsed.toFixed(2)}${epsBasis ? ' (' + epsBasis + ')' : ''}`,
    `× ${multLow.toFixed(1)}–${multHigh.toFixed(1)}x${multBasis ? ' (' + multBasis + ')' : ''} → справедливо $${fair.low.toFixed(0)}–${fair.high.toFixed(0)}`,
    `задето опор: ${nDam} → MoS ${(mos * 100).toFixed(0)}% → привлекательно $${zone.low.toFixed(0)}–${zone.high.toFixed(0)}`,
    minGap ? `разнос ≥ ${SPACING_SIGMA}σ` : 'σ недоступна — разнос не проверялся',
  ].join('; ');
  return { t1: lv[0], t2: lv[1], t3: lv[2], fair, zone, basis };
}

// intact: предложить склеенную сетку для слипшихся уровней (флаг merge в #5)
function suggestMergedGrid(lv, sigmaUsd) {
  const nums = (lv || []).filter(v => v != null && v !== 999);
  if (nums.length < 2 || !(sigmaUsd > 0)) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const anchor = sorted[Math.floor(sorted.length / 2)];
  const gap = SPACING_SIGMA * sigmaUsd;
  return {
    anchor,
    grid: [anchor + gap, anchor, anchor - gap].map(v => Math.round(v * 100) / 100),
    reason: `уровни ближе ${SPACING_SIGMA}σ — фактически один; предложить сетку ${[anchor + gap, anchor, anchor - gap].map(v => Math.round(v)).join(' / ')} (разнос 0.75σ)`,
  };
}

// замена уровня-фантазии: сканируем вниз от цены до P(касания) ≥ targetP.
// Замена всегда МЕЖДУ ценой и уровнем-фантазией (ближе к цене = достижимее)
function suggestReplacement({ px, level, muAnn, sigAnn, horizonYr = 1, pTouch, targetP = 0.10 }) {
  if (!(px > 0) || !(sigAnn > 0) || typeof pTouch !== 'function' || !(level > 0)) return null;
  for (let k = 0.25; k <= 3.001; k += 0.25) {
    const cand = px * (1 - k * sigAnn);
    if (cand <= 0 || cand <= level) continue; // замена выше фантазийного уровня
    const p = pTouch(px, cand, muAnn, sigAnn, horizonYr);
    if (p >= targetP) {
      return { level: Math.round(cand * 100) / 100, p, reason: `P(касания) поднять до ${(p * 100).toFixed(0)}% (было <5%)` };
    }
  }
  return null;
}

// уход цены >25% от derived_at — перевывод обязателен
function needsRederive(record, px) {
  if (!record?.levels?.px_at || !(px > 0)) return false;
  return Math.abs(px / record.levels.px_at - 1) > REDERIVE_MOVE;
}

// ── I/O: вывод уровней по тикеру (LLM даёт якоря, математика собирает) ──
const DERIVE_SCHEMA = {
  eps: 'number', eps_basis: 'string',
  multiple_low: 'number', multiple_high: 'number', multiple_basis: 'string',
  haircut_pct: 'number',
  confirm_event: 'string', confirm_check: 'string',
  levels: 'array',
  exit_target: 'number', exit_deadline_days: 'number', exit_note: 'string',
};

async function currentPx(T) {
  const d = await chart(T).catch(() => null);
  return d?.price ?? (d?.closes?.length ? d.closes.at(-1) : null);
}

// годовая σ в долларах: из кэша калибровки уровней (GARCH), иначе sd ряда
async function sigmaUsdOf(T, px) {
  const cached = readCache('levels', 7 * 864e5);
  const it = cached?.items?.find(i => i.t === T);
  if (it?.sigAnn > 0) return it.sigAnn * px;
  const d = await chart(T, '2y').catch(() => null);
  if (!d?.closes?.length || d.closes.length < 60 || !(px > 0)) return null;
  const rets = d.closes.slice(1).map((v, i) => Math.log(v / d.closes[i]));
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(252) * px;
}

const storeDefault = () => require('./theses');

// перевывод уровней тикера по его текущему состоянию.
// anchors — уже готовые фундаментальные якоря (например, из T+1 сверки
// отчёта): LLM-вызов пропускается, считается только математика.
// Возвращает { levels?, exit_plan?, error? } и пишет в запись тезиса.
async function runDerive(T, { llm = defaultLlm, store = storeDefault(), news = null, filings = null, px = null, trigger = 'manual', anchors = null } = {}) {
  const t = String(T || '').toUpperCase().trim();
  const rec = store.get(t) || store.getOrSeed?.(t);
  if (!rec) throw new Error(`${t}: нет записи тезиса`);
  if (rec.state === 'dead') return deriveExit(t, rec, { llm, px: px ?? await currentPx(t), news, filings, trigger });

  const price = px ?? await currentPx(t);
  const sig = price ? await sigmaUsdOf(t, price).catch(() => null) : null;
  const needLlm = !(anchors && anchors.eps > 0 && anchors.multiple_low > 0);
  let nw = news, fl = filings;
  if (needLlm && [news, filings].some(x => x == null)) {
    [nw, fl] = await Promise.all([news ?? fetchHeadlines(t).catch(() => []), filings ?? edgarRecent(t).catch(() => [])]);
  } else if (nw == null) nw = [];
  if (fl == null) fl = [];

  const v = needLlm
    ? await llm.chat(
        [{ role: 'system', content: PROMPTS.levelsDerive.system },
         { role: 'user', content: PROMPTS.levelsDerive.user({ rec, px: price, sigmaUsd: sig, news: nw, filings: fl }) }],
        { schema: DERIVE_SCHEMA, task: 'levels-derive', t, temperature: 0.2 },
      )
    : { ...anchors, levels: [], exit_target: 0, exit_deadline_days: 0, exit_note: '' };

  const out = { derived_at: new Date().toISOString(), px_at: price, trigger };
  if (rec.state === 'damaged') {
    const d = deriveDamaged({
      eps: +v.eps, multLow: +v.multiple_low, multHigh: +v.multiple_high,
      haircutPct: +v.haircut_pct || 0,
      damagedPillars: rec.damaged_pillars?.length || 1,
      sigmaUsd: sig, epsBasis: v.eps_basis, multBasis: v.multiple_basis,
    });
    if (d.error) return { error: d.error };
    const until = overrides.validUntil(v.confirm_event, v.confirm_check);
    if (!until) return { error: 'нет данных: damaged-уровень требует условия подтверждения (цена + факт)' };
    const levels = { t1: d.t1, t2: d.t2, t3: d.t3, conditional: true, until, ...out, basis: d.basis };
    return commitLevels(store, rec, levels, trigger);
  }

  // intact / recovering / watch: прямой план [T1,T2,T3] от агента, валидируется
  const lv = overrides.validLv(v.levels, price);
  if (!lv) return { error: 'нет данных: агент не дал валидной сетки уровней' };
  const until = overrides.validUntil(v.confirm_event, v.confirm_check);
  const spaced = sig ? enforceSpacing(lv.map(x => x), SPACING_SIGMA * sig) : lv;
  const levels = { t1: spaced[0], t2: spaced[1], t3: spaced[2], conditional: rec.state === 'recovering', until, ...out,
    basis: `состояние ${rec.state}: план агента${sig ? ', разнос ≥0.75σ' : ''}${until ? ', активация с подтверждением' : ''}` };
  return commitLevels(store, rec, levels, trigger);
}

function commitLevels(store, rec, levels, trigger) {
  const hist = { ts: levels.derived_at, t1: levels.t1, t2: levels.t2, t3: levels.t3, trigger, basis: levels.basis };
  const next = {
    ...rec, levels,
    levels_history: [...(rec.levels_history || []), hist].slice(-20),
    updated_at: new Date().toISOString(),
  };
  store.saveRecord(next);
  return { levels };
}

// dead: не уровни, а план выхода — целевая цена на отскоке, дедлайн, правило
async function deriveExit(T, rec, { llm = defaultLlm, px = null, news = null, filings = null, trigger = 'manual' } = {}) {
  const price = px ?? await currentPx(T);
  const [nw, fl] = [news, filings].some(x => x == null)
    ? await Promise.all([news ?? fetchHeadlines(T).catch(() => []), filings ?? edgarRecent(T).catch(() => [])])
    : [news || [], filings || []];
  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.levelsDerive.system },
     { role: 'user', content: PROMPTS.levelsDerive.user({ rec, px: price, sigmaUsd: null, news: nw, filings: fl }) }],
    { schema: DERIVE_SCHEMA, task: 'levels-derive', t: T, temperature: 0.2 },
  );
  const days = Math.round(+v.exit_deadline_days) || 90;
  const exit_plan = {
    target: +v.exit_target > 0 ? +v.exit_target : null,
    deadline: new Date(Date.now() + days * 864e5).toISOString().slice(0, 10),
    note: String(v.exit_note || '').slice(0, 300) || `продать в любом случае к дате выхода (окно ${days} дн)`,
    derived_at: new Date().toISOString(), px_at: price, trigger,
  };
  const next = { ...rec, levels: null, exit_plan, updated_at: new Date().toISOString() };
  store.saveRecord(next);
  return { exit_plan };
}

module.exports = {
  MOS_BY_PILLARS, SPACING_SIGMA, REDERIVE_MOVE,
  mosForDamaged, fairRange, attractiveZone, enforceSpacing, deriveDamaged,
  suggestMergedGrid, suggestReplacement, needsRederive, runDerive, deriveExit,
};
