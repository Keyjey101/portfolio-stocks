// #10 комитет агентов с калибровкой: бык/медведь/адвокат дьявола/базовые ставки.
// Каждое утверждение — вероятностный прогноз машинно-разрешимой грамматики;
// созревшие прогнозы разрешаются ценами → Brier по ролям → веса консенсуса.
const fs = require('fs');
const path = require('path');
const defaultLlm = require('../llm');
const { readCache } = require('../cache');
const { getCalendar } = require('../signals');
const { getData } = require('../signals');
const { chart, pool } = require('../yahoo');

const PRED_FILE = path.join(__dirname, '..', '..', 'data', 'predictions.jsonl');

const ROLES = [
  { id: 'bull', name: 'Бык' },
  { id: 'bear', name: 'Медведь' },
  { id: 'devil', name: 'Адвокат дьявола' },
  { id: 'baserates', name: 'Базовые ставки' },
];

function readPreds() {
  try { return fs.readFileSync(PRED_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function writePreds(rows) {
  fs.mkdirSync(path.dirname(PRED_FILE), { recursive: true });
  fs.writeFileSync(PRED_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ── грамматика событий ──
const KINDS = ['price_above', 'price_below', 'index_above', 'index_below', 'vix_above', 'vix_below'];

function validateEvent(e) {
  if (!e || !KINDS.includes(e.kind)) return null;
  const hd = Math.round(+e.horizon_days);
  if (!(hd >= 7 && hd <= 365)) return null;
  if (String(e.kind).startsWith('price_')) {
    const t = String(e.t || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]*$/.test(t)) return null;
    const ref = +e.ref, x = +e.x;
    if (!(ref > 0) || !(x > 0 && x <= 0.5)) return null;
    return { kind: e.kind, t, ref, x, horizon_days: hd };
  }
  if (String(e.kind).startsWith('index_')) {
    const ref = +e.ref, x = +e.x;
    if (!(ref > 0) || !(x > 0 && x <= 0.5)) return null;
    return { kind: e.kind, ref, x, horizon_days: hd };
  }
  const level = +e.level;
  if (!(level > 0 && level < 200)) return null;
  return { kind: e.kind, level, horizon_days: hd };
}

// {SYM: текущая цена} → true/false/null (null — данных нет);
// сравнения с относительным эпсилоном против fp-погрешности на границе
function resolveEvent(e, px) {
  if (!e || !px) return null;
  const ge = (a, b) => a >= b * (1 - 1e-9);
  const le = (a, b) => a <= b * (1 + 1e-9);
  switch (e.kind) {
    case 'price_above': {
      const p = px[e.t];
      return p == null ? null : ge(p, e.ref * (1 + e.x));
    }
    case 'price_below': {
      const p = px[e.t];
      return p == null ? null : le(p, e.ref * (1 - e.x));
    }
    case 'index_above': {
      const p = px['^GSPC'];
      return p == null ? null : ge(p, e.ref * (1 + e.x));
    }
    case 'index_below': {
      const p = px['^GSPC'];
      return p == null ? null : le(p, e.ref * (1 - e.x));
    }
    case 'vix_above': return px['^VIX'] == null ? null : ge(px['^VIX'], e.level);
    case 'vix_below': return px['^VIX'] == null ? null : le(px['^VIX'], e.level);
    default: return null;
  }
}

// ── контекст и созыв комитета ──
async function defaultContextLoader() {
  const D = await getData();
  const factors = readCache('factors', 7 * 864e5);
  const detector = readCache('detector', 3 * 864e5);
  let earnings = [];
  try { earnings = (await getCalendar()).items.slice(0, 8); } catch {}
  const topFactors = factors
    ? Object.entries(factors.exposure).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
      .map(([f, b]) => `${f}: ${b.toFixed(2)}`)
    : [];
  const tickers = D.rows.filter(r => r.ok).slice(0, 25).map(r => r.t);
  return {
    total: Math.round(D.total),
    verdict: D.verdict.t,
    rules: D.rules,
    topFactors,
    detectorFlags: (detector?.verdicts || []).map(v => `${v.t} ${v.verdict}`),
    earnings: earnings.map(e => `${e.t} через ${e.days} дн`),
    tickers,
    spx: D.spxPx, vix: D.vixV,
  };
}

function rolePrompt(role, ctx) {
  const persona = {
    bull: 'Ты убеждённый бык: ищи аргументы за рост, но давай честные вероятности.',
    bear: 'Ты убеждённый медведь: ищи аргументы за падение, но давай честные вероятности.',
    devil: 'Ты адвокат дьявола: атакуй консенсус, ищи то, что все упускают.',
    baserates: 'Ты опираешься только на базовые ставки и историческую частоту событий, без нарративов.',
  }[role];
  return [
    persona,
    '',
    'Портфель: $' + (ctx.total || '?') + ', вердикт системы: ' + (ctx.verdict || '?') + '.',
    'Факторные экспозиции: ' + (ctx.topFactors?.join(', ') || 'нет') + '.',
    'Флаги детектора: ' + (ctx.detectorFlags?.join(', ') || 'нет') + '.',
    'Отчёты близко: ' + (ctx.earnings?.join(', ') || 'нет') + '.',
    'S&P ' + (ctx.spx || '?') + ', VIX ' + (ctx.vix || '?') + '.',
    'Тикеры портфеля: ' + (ctx.tickers?.join(', ') || '') + '.',
    '',
    'Дай РОВНО ПЯТЬ прогнозов на 7–365 дней вперёд в строгой грамматике:',
    '{"kind":"price_above"|"price_below","t":"ТИКЕР","ref":<цена сейчас>,"x":<доля, напр. 0.08>,"horizon_days":N}',
    '{"kind":"index_above"|"index_below","ref":<уровень S&P сейчас>,"x":<доля>,"horizon_days":N}',
    '{"kind":"vix_above"|"vix_below","level":N,"horizon_days":N}',
    'prob — твоя вероятность 0.05..0.95; rationale — одна фраза.',
    'Верни ТОЛЬКО JSON: {"predictions":[{…5 шт…}]}',
  ].join('\n');
}

async function runCommittee({ llm = defaultLlm, contextLoader = defaultContextLoader } = {}) {
  const ctx = await contextLoader();
  const rows = [];
  for (const role of ROLES) {
    if (rows.length) await new Promise(r => setTimeout(r, 3000)); // бережём rate-limit
    const v = await llm.chat(
      [{ role: 'system', content: 'Ты участник инвестиционного комитета. Отвечай только JSON.' },
       { role: 'user', content: rolePrompt(role.id, ctx) }],
      { schema: { predictions: 'array' }, task: 'committee', t: role.id, temperature: 0.4 },
    ).catch(() => ({ predictions: [] }));
    let kept = 0;
    for (const p of v.predictions || []) {
      if (kept >= 5) break;
      const event = validateEvent(p);
      const prob = +p.prob;
      if (!event || !(prob >= 0.05 && prob <= 0.95)) continue;
      rows.push({
        ts: new Date().toISOString(), role: role.id, event, prob,
        rationale: String(p.rationale || '').slice(0, 300),
      });
      kept++;
    }
  }
  const existing = readPreds();
  writePreds([...existing, ...rows]);
  return { appended: rows.length, at: new Date().toISOString() };
}

// ── скоринг созревших ──
async function defaultPriceLoader(symbols) {
  const out = {};
  await pool([...new Set(symbols)], async s => {
    const d = await chart(s).catch(() => null);
    if (d && d.price != null) out[s] = d.price;
  });
  return out;
}

async function scoreMatured({ priceLoader = defaultPriceLoader } = {}) {
  const rows = readPreds();
  const need = new Set();
  const now = Date.now();
  rows.forEach(r => {
    if (r.outcome != null) return;
    const due = Date.parse(r.ts) + r.event.horizon_days * 864e5;
    if (now < due) return;
    if (String(r.event.kind).startsWith('price_')) need.add(r.event.t);
    else if (String(r.event.kind).startsWith('index_')) need.add('^GSPC');
    else need.add('^VIX');
  });
  const px = need.size ? await priceLoader([...need]) : {};
  let scored = 0;
  for (const r of rows) {
    if (r.outcome != null) continue;
    const due = Date.parse(r.ts) + r.event.horizon_days * 864e5;
    if (now < due) continue;
    const o = resolveEvent(r.event, px);
    if (o == null) continue;
    r.outcome = o;
    r.resolvedAt = new Date().toISOString();
    scored++;
  }
  if (scored) writePreds(rows);
  return scored;
}

function brierByRole() {
  const rows = readPreds().filter(r => r.outcome != null);
  const acc = {};
  for (const r of rows) {
    acc[r.role] = acc[r.role] || { s: 0, n: 0 };
    acc[r.role].s += (r.prob - (r.outcome ? 1 : 0)) ** 2;
    acc[r.role].n++;
  }
  const out = {};
  for (const [role, { s, n }] of Object.entries(acc)) out[role] = s / n;
  return out;
}

function consensusWeights() {
  const b = brierByRole();
  const eligible = Object.entries(b).filter(([, v]) => v != null);
  if (!eligible.length) return {};
  // роли без истории не входят
  const exp = Object.fromEntries(eligible.map(([r, v]) => [r, Math.exp(-v)]));
  const z = Object.values(exp).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.entries(exp).map(([r, v]) => [r, v / z]));
}

// калибровка: бакеты заявленной вероятности против частоты реализации
function calibration() {
  const rows = readPreds().filter(r => r.outcome != null);
  const buckets = [];
  for (let lo = 0; lo < 1; lo += 0.2) {
    const inB = rows.filter(r => r.prob >= lo && r.prob < lo + 0.2);
    buckets.push({
      lo: +lo.toFixed(1),
      n: inB.length,
      claimed: +(lo + 0.1).toFixed(1),
      hitRate: inB.length ? inB.filter(r => r.outcome).length / inB.length : null,
    });
  }
  return buckets;
}

module.exports = {
  ROLES, validateEvent, resolveEvent,
  runCommittee, scoreMatured, brierByRole, consensusWeights, calibration,
};
