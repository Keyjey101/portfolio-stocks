// #М5 запрос «стоит ли покупать X» — единая точка входа вместо внешнего
// аналитика. Вход: тикер + сумма. Выход — структура по фиксированному
// чек-листу (состояние тезиса → события → классификация движения → уровни →
// мандат → проксимити отчёта → базовые ставки → РЕШЕНИЕ → размер).
// Пункт «решение» обязан быть однозначным; данных не хватает — «нет решения»
// со списком недостающего, а не выдуманное число. Размер считает машина.
const fs = require('fs');
const path = require('path');
const { chart } = require('../yahoo');
const { fetchHeadlines } = require('../news');
const { edgarRecent } = require('../edgar');
const { readCache } = require('../cache');
const { getData, getCalendar } = require('../signals');
const { RULES } = require('../portfolio');
const { PROMPTS } = require('../prompts');
const defaultLlm = require('../llm');
const theses = require('./theses');

const RECS_FILE = path.join(__dirname, '..', '..', 'data', 'recs.jsonl');

const DECISION_SCHEMA = {
  classification: 'enum:beta,noise,damage,unknown',
  decision: 'enum:buy_full,buy_half,wait,no,no_decision',
  wait_what: 'string',
  missing: 'array',
  reason: 'string',
};

const DET_CLASS = {
  beta_move: 'beta', idiosyncratic_temporary: 'noise', thesis_damage: 'damage',
};

// проверки мандата ДО покупки: что пробьётся, если купить на usd
function constraintCheck({ row, total, cash, usd, tag }) {
  if (!(total > 0) || !row) return null;
  const isCore = tag === 'core';
  const coreVal = row.coreVal ?? 0;
  const totalAfter = total + usd;
  return {
    aiPct: (coreVal + (isCore ? usd : 0)) / totalAfter,
    aiBreached: (coreVal + (isCore ? usd : 0)) / totalAfter > RULES.aiCeiling + 1e-9,
    namePctAfter: (row.val + usd) / totalAfter,
    nameBreached: (row.val + usd) / totalAfter > RULES.maxNamePct + 1e-9,
    cashAfter: cash - usd,
    cashPctAfter: (cash - usd) / (total + cash),
    cashBreached: cash - usd < 0,
  };
}

async function runBuyCheck({ t, usd, llm = defaultLlm, dataLoader = getData, calendarLoader = getCalendar, now = new Date() } = {}) {
  const T = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(T)) throw new Error('введи тикер латиницей, например TSM');
  const usdNum = +usd;
  if (!(usdNum > 0)) throw new Error('сумма должна быть положительным числом');

  // …1. состояние тезиса + история переходов
  const thesis = theses.get(T);
  // …2. события: календарь + новости/филлинги за 30 дней
  const [D, cal] = await Promise.all([
    dataLoader().catch(() => null),
    calendarLoader().catch(() => ({ items: [] })),
  ]);
  const calItem = (cal.items || []).find(i => i.t === T) || null;
  const days = calItem ? calItem.days : null;

  const row = D?.rows?.find(r => r.t === T) || null;
  const watchRow = row ? null : (D?.watch || []).find(w => w.t === T) || null;
  const px = row?.px ?? watchRow?.px ?? (await chart(T).catch(() => null))?.price ?? null;
  if (px == null) throw new Error(`${T}: не удалось получить цену — проверь тикер`);

  const [news, filings] = await Promise.all([
    fetchHeadlines(T).catch(() => []),
    edgarRecent(T).catch(() => []),
  ]);

  // …3. классификация движения: детектор, если свежий вердикт есть
  const det = readCache('detector', 3 * 864e5);
  const detV = (det?.verdicts || []).find(v => v.t === T) || null;
  const movement = {
    class: detV ? DET_CLASS[detV.verdict] || 'unknown' : 'unknown',
    reason: detV?.reason || null,
    sigma: detV ? { last: detV.lastSigma, cum5: detV.cumSigma } : null,
  };

  // …4. уровни: активны ли, в зоне ли, условие ожидания, заморозка
  const lv = readCache('levels', 2 * 864e5);
  const lvItem = (lv?.items || []).find(i => i.t === T) || null;
  const thLv = thesis?.levels;
  const activeLv = thLv || (lvItem ? { t1: lvItem.levels?.[0]?.v ?? null, t2: lvItem.levels?.[1]?.v ?? null, t3: lvItem.levels?.[2]?.v ?? null, until: lvItem.until } : null);
  const l1 = activeLv?.t1 ?? null, l2 = activeLv?.t2 ?? null, l3 = activeLv?.t3 ?? null;
  const levels = activeLv && [l1, l2, l3].some(v => v != null)
    ? {
      active: true, t1: l1, t2: l2, t3: l3,
      inZone: (l1 != null && px <= l1) || (l2 != null && px <= l2) || (l3 != null && px <= l3),
      until: activeLv.until?.event || null,
      frozen: lvItem?.frozen || (days != null && days <= 7) || null,
      thesisState: thesis?.state || null,
    }
    : { active: false, thesisState: thesis?.state || null };

  // …5. ограничения мандата после покупки
  const coreVal = D ? (D.rows || []).filter(r => r.ok && r.tag === 'core').reduce((s, r) => s + r.val, 0) : 0;
  const constraints = D
    ? constraintCheck({ row: row ? { ...row, coreVal } : { val: 0, coreVal }, total: D.total, cash: D.cash, usd: usdNum, tag: row?.tag || watchRow?.tag || null })
    : null;

  // …7. базовые ставки: класс недавнего события (если детектор что-то нашёл)
  let baserates = null;
  if (detV?.reason) {
    try {
      const br = require('./baserates');
      const r = await br.query(`ситуация по ${T}: ${detV.reason}`);
      const agg = r?.empirical || null;
      baserates = { class: r?.classification || null, median12m: agg?.medianFwd?.[3] ?? null, n: agg?.n ?? null };
    } catch { /* базовые ставки не критичны для решения */ }
  }

  const missing = [];
  if (!thesis) missing.push('запись тезиса (сгенерируй фальсификации по тикеру)');
  if (!levels.active) missing.push('активные уровни');
  if (!constraints) missing.push('данные портфеля для проверки мандата');
  if (days == null) missing.push('дата следующего отчёта');

  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.buyCheck.system },
     { role: 'user', content: PROMPTS.buyCheck.user({
       t: T, usd: usdNum, px,
       thesis: thesis ? { state: thesis.state, history: thesis.history } : {},
       calendar: { days },
       movement,
       levels,
       mandate: constraints ? {
         aiPct: constraints.aiPct, namePctAfter: constraints.namePctAfter,
         cashPctAfter: constraints.cashPctAfter,
       } : {},
       baserates,
       detector: detV ? { verdict: detV.verdict, reason: detV.reason } : null,
       news, filings,
     }) }],
    { schema: DECISION_SCHEMA, task: 'buycheck', t: T, temperature: 0.2 },
  );

  // …9. размер: считает машина, не агент
  const shares = px > 0 ? Math.floor(usdNum / px) : null;
  const size = constraints && row
    ? {
      shares,
      usd: usdNum, px,
      namePctBefore: row.val / D.total,
      namePctAfter: constraints.namePctAfter,
      aiPctAfter: constraints.aiPct,
      cashLeft: constraints.cashAfter,
    }
    : { shares, usd: usdNum, px };

  // лог для будущей «точности советов» (#М8)
  try {
    fs.mkdirSync(path.dirname(RECS_FILE), { recursive: true });
    fs.appendFileSync(RECS_FILE, JSON.stringify({ ts: now.toISOString(), kind: 'buycheck', t: T, decision: v.decision, usd: usdNum, px }) + '\n');
  } catch { /* лог не должен ломать ответ */ }

  return {
    t: T, usd: usdNum, px, generatedAt: now.toISOString(),
    checklist: {
      thesis: thesis ? { state: thesis.state, history: thesis.history, damaged_pillars: thesis.damaged_pillars } : null,
      events: { earningsDays: days, news: news.slice(0, 5), filings: filings.slice(0, 5) },
      movement, levels, constraints, baserates,
      binaryRisk: days != null && days <= 7 ? { days } : null,
    },
    decision: v.decision,
    wait_what: v.wait_what || null,
    missing: [...new Set([...(v.missing || []).map(String), ...missing])],
    reason: v.reason,
    classification: v.classification,
    size,
  };
}

module.exports = { runBuyCheck, constraintCheck };
