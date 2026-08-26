// #М4 движок ограничений мандата — первое, что владелец спрашивает перед
// покупкой. Считается из живых данных (позиции/кэш) и суточных кэшей
// (факторы, тезисы). AI-бета показывается ДВУМЯ способами: по тегам META
// (прозрачно, субъективно) и по факторной модели (Σwᵢβᵢ к ортогонализованному
// SMH — эмпирично); расхождение между ними само по себе информативно.
const { getData } = require('../signals');
const { readCache } = require('../cache');
const { CASH, RULES } = require('../portfolio');
const theses = require('./theses');

const DAY = 864e5;

// медиана по числам (для «типичной» β AI-ядра)
const median = a => {
  const s = a.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// ── Чистая сборка панели по строкам книги + кэшам ──
// rows: [{t, tag, val, ok…}] как из getData; factors: кэш факторной модели;
// thesesItems: {TICKER: запись тезиса}; cash: свободные деньги.
function buildPanel({ rows, total, cash = 0, factors = null, thesesItems = {}, rules = RULES, now = new Date() }) {
  const ok = rows.filter(r => r.ok && r.val > 0);
  const sumBy = pred => ok.filter(pred).reduce((s, r) => s + r.val, 0);

  // 1. AI-бета по тегам (как в rules.js, но с деталями для панели)
  const coreVal = sumBy(r => r.tag === 'core');
  const indexVal = sumBy(r => r.tag === 'index');
  const aiTagPct = total > 0 ? coreVal / total : 0;
  const aiHiddenPct = total > 0 ? (coreVal + indexVal * rules.hiddenAiFactor) / total : 0;

  // 2. AI-бета по факторной модели: Σwᵢβᵢ(орто-SMH) ядра + эффективная доля.
  // Эффективная доля = β ядра / медианная β имени ядра — «сколько книги
  // ведёт себя как AI», в сопоставимых с тегами процентах.
  let aiFactor = null;
  if (factors?.aiOrthSmh != null) {
    const coreTickers = new Set(ok.filter(r => r.tag === 'core').map(r => r.t));
    const medBeta = median([...coreTickers].map(t => factors.orthBetas?.[t]?.SMH).filter(v => v != null));
    aiFactor = {
      beta: factors.aiOrthSmh,
      medBeta,
      effShare: medBeta > 0.05 ? factors.aiOrthSmh / medBeta : null,
      generatedAt: factors.generatedAt,
    };
  }

  // 3. кэш
  const cashTarget = total * rules.cashTargetPct;
  const cashShare = total + cash > 0 ? cash / (total + cash) : 0;

  // 4. макс. имя
  const maxRow = ok.reduce((a, r) => (r.val > (a ? a.val : -1) ? r : a), null);

  // 5. сломанные тезисы — из машины состояний (damaged/dead), не из ручных меток
  const brokenRows = ok.filter(r => {
    const st = thesesItems[r.t]?.state;
    return st === 'damaged' || st === 'dead';
  });
  const brokenVal = brokenRows.reduce((s, r) => s + r.val, 0);
  const brokenOverdue = brokenRows.filter(r => theses.reviewOverdue(thesesItems[r.t], now)).map(r => r.t);

  // 6. эффективное число ставок
  const enb = factors?.enb ?? null;
  const nPos = ok.length;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    generatedAt: now.toISOString(),
    aiTags: {
      pct: aiTagPct, hiddenPct: aiHiddenPct, val: coreVal,
      target: rules.aiCeiling,
      excess: coreVal - rules.aiCeiling * total,
      c: aiTagPct > rules.aiCeiling + 1e-9 ? 'r' : aiHiddenPct > rules.aiCeiling + 1e-9 ? 'o' : 'g',
    },
    aiFactor,
    aiDivergence: aiFactor?.effShare != null
      ? { tagPct: aiTagPct, factorPct: aiFactor.effShare, gapPct: aiFactor.effShare - aiTagPct }
      : null,
    cash: {
      pct: cashShare, val: cash, target: rules.cashTargetPct,
      short: Math.max(0, cashTarget - cash),
      c: cashTarget > cash + 1e-9 ? 'o' : 'g',
    },
    maxName: {
      t: maxRow?.t ?? null, pct: maxRow && total > 0 ? maxRow.val / total : 0,
      val: maxRow?.val ?? null, target: rules.maxNamePct,
      c: maxRow && total > 0 && maxRow.val / total > rules.maxNamePct + 1e-9 ? 'r' : 'g',
    },
    broken: {
      pct: total > 0 ? brokenVal / total : 0, val: brokenVal,
      n: brokenRows.length, list: brokenRows.map(r => r.t), overdue: brokenOverdue,
      c: brokenRows.length ? (brokenOverdue.length ? 'r' : 'o') : 'g',
    },
    enb: { value: enb, n: nPos, share: enb != null && nPos ? clamp(enb / nPos, 0, 1) : null,
      c: 'd', factorsAt: factors?.generatedAt ?? null },
  };
}

// ── I/O: сборка из живых данных + суточных кэшей ──
async function runMandate({ dataLoader = getData, factorsLoader = null } = {}) {
  const D = await dataLoader();
  const factors = factorsLoader
    ? await factorsLoader().catch(() => null)
    : readCache('factors', 2 * DAY);
  return buildPanel({
    rows: D.rows, total: D.total, cash: D.cash ?? CASH,
    factors, thesesItems: theses.listAll(),
  });
}

// гость: проценты остаются, доллары вырезаются (как sanitizeForGuest)
function sanitizePanel(P) {
  return {
    ...P,
    aiTags: { ...P.aiTags, val: null, excess: null },
    cash: { ...P.cash, val: null, short: null },
    maxName: { ...P.maxName, val: null },
    broken: { ...P.broken, val: null },
    guest: true,
  };
}

module.exports = { buildPanel, runMandate, sanitizePanel, median };
