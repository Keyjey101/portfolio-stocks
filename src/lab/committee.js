// #10 комитет агентов с калибровкой: бык/медведь/адвокат дьявола/базовые ставки.
// Каждое утверждение — вероятностный прогноз машинно-разрешимой грамматики;
// созревшие прогнозы разрешаются ценами → Brier по ролям → веса консенсуса.
// #М7: скоринг ОТНОСИТЕЛЬНО baseline (случайное блуждание при текущей σ),
// а не абсолютный: Brier мерил смещение персоны, а не навык. Метрика —
// Brier Skill Score: 1 − BS_agent/BS_baseline; ниже нуля = хуже монетки.
// Неинформативные прогнозы (|prob − baseline| < 0.10) не засчитываются;
// набор роли обязан содержать ≥1 горизонт ≤30 дней, иначе отклоняется.
const fs = require('fs');
const path = require('path');
const defaultLlm = require('../llm');
const { PROMPTS } = require('../prompts');
const { readCache } = require('../cache');
const { getCalendar } = require('../signals');
const { getData } = require('../signals');
const { chart, pool } = require('../yahoo');
const { normCdf } = require('../math/stats');

const INFORMATIVE_EDGE = 0.10; // |prob − baseline| меньше — прогноз не засчитывается
const MIN_SHORT_H = 30;        // в наборе роли нужен горизонт ≤ этого

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

// ── #М7 baseline: вероятность из случайного блуждания при текущей σ ──
// drift 0 (честный прокси «без мнения»), σ — дневная, оценка на момент
// прогноза. VIX-события без уровня на момент ts — baseline неизвестен.
function baselineProb(e, sigDaily) {
  if (!e || !(sigDaily > 0)) return null;
  const s = sigDaily * Math.sqrt(e.horizon_days);
  switch (e.kind) {
    case 'price_above': case 'index_above':
      return 1 - normCdf(Math.log(1 + e.x) / s);
    case 'price_below': case 'index_below':
      return normCdf(Math.log(1 - e.x) / s);
    default:
      return null;
  }
}

// σ дневная по ряду до момента ts (последние ≤252 доходности до ts)
function sigmaBefore(tsMs, { closes = [], ts = [] } = {}) {
  let end = -1;
  for (let i = 0; i < ts.length; i++) if ((ts[i] ?? 0) * 1000 <= tsMs) end = i;
  if (end < 21) return null;
  const win = closes.slice(Math.max(0, end - 252), end + 1);
  const rets = win.slice(1).map((v, i) => Math.log(v / win[i]));
  const m = rets.reduce((s, v) => s + v, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / (rets.length - 1));
}

// событие → символ, по которому считается σ
const sigmaSymbolOf = e =>
  String(e.kind).startsWith('price_') ? e.t
    : String(e.kind).startsWith('index_') ? '^GSPC' : null;

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
  let thesisStates = [];
  try {
    thesisStates = Object.values(require('./theses').listAll())
      .filter(th => th.state !== 'intact')
      .map(th => `${th.t}:${th.state}`);
  } catch {}
  return {
    total: Math.round(D.total),
    verdict: D.verdict.t,
    rules: D.rules,
    topFactors,
    detectorFlags: (detector?.verdicts || []).map(v => `${v.t} ${v.verdict}`),
    thesisStates,
    earnings: earnings.map(e => `${e.t} через ${e.days} дн`),
    tickers,
    spx: D.spxPx, vix: D.vixV,
  };
}

function rolePrompt(role, ctx) {
  return PROMPTS.committee.user({ role, ctx });
}

// загрузчик σ для проверки информативности на входе (6 мес истории)
async function defaultVolLoader(symbols) {
  const out = {};
  await pool([...new Set(symbols)], async s => {
    const d = await chart(s, '6mo').catch(() => null);
    if (d?.closes?.length > 21) {
      const rets = d.closes.slice(1).map((v, i) => Math.log(v / d.closes[i]));
      const m = rets.reduce((s2, v) => s2 + v, 0) / rets.length;
      out[s] = Math.sqrt(rets.reduce((s2, v) => s2 + (v - m) ** 2, 0) / (rets.length - 1));
    }
  });
  return out;
}

async function runCommittee({ llm = defaultLlm, contextLoader = defaultContextLoader, volLoader = defaultVolLoader } = {}) {
  const ctx = await contextLoader();
  const rows = [];
  const rejected = [];
  for (const role of ROLES) {
    if (rows.length) await new Promise(r => setTimeout(r, 3000)); // бережём rate-limit
    const v = await llm.chat(
      [{ role: 'system', content: PROMPTS.committee.system },
       { role: 'user', content: rolePrompt(role.id, ctx) }],
      { schema: { predictions: 'array' }, task: 'committee', t: role.id, temperature: 0.4 },
    ).catch(() => ({ predictions: [] }));
    const batch = [];
    for (const p of v.predictions || []) {
      if (batch.length >= 5) break;
      const event = validateEvent(p);
      const prob = +p.prob;
      if (!event || !(prob >= 0.05 && prob <= 0.95)) continue;
      batch.push({
        ts: new Date().toISOString(), role: role.id, event, prob,
        rationale: String(p.rationale || '').slice(0, 300),
      });
    }
    // #М7: без короткого горизонта набор отклоняется целиком — иначе первая
    // оценка роли появится только через год
    if (batch.length && !batch.some(r => r.event.horizon_days <= MIN_SHORT_H)) {
      rejected.push({ role: role.id, reason: `нет прогноза с горизонтом ≤${MIN_SHORT_H} дн — набор отклонён` });
      continue;
    }
    rows.push(...batch);
  }

  // #М7: неинформативные (|prob − baseline| < 0.10) не засчитываются.
  // σ недоступна (сеть) — прогноз остаётся, информативность решится при оценке
  const sigSyms = rows.map(r => sigmaSymbolOf(r.event)).filter(Boolean);
  const vols = sigSyms.length ? await volLoader(sigSyms).catch(() => ({})) : {};
  const keptRows = [];
  const dropped = [];
  for (const r of rows) {
    const sym = sigmaSymbolOf(r.event);
    const base = sym ? baselineProb(r.event, vols[sym]) : null;
    if (base != null && Math.abs(r.prob - base) < INFORMATIVE_EDGE) {
      dropped.push({ role: r.role, event: r.event, prob: r.prob, baseline: +base.toFixed(3), why: '|prob − baseline| < 0.10' });
      continue;
    }
    if (base != null) { r.baseline = +base.toFixed(3); r.sigmaAt = vols[sym]; }
    keptRows.push(r);
  }
  const existing = readPreds();
  writePreds([...existing, ...keptRows]);
  return { appended: keptRows.length, dropped, rejected, at: new Date().toISOString() };
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

// история для точного baseline при оценке (σ на момент прогноза)
async function defaultHistoryLoader(symbols) {
  const out = {};
  await pool([...new Set(symbols)], async s => {
    const d = await chart(s, '2y').catch(() => null);
    if (d?.closes?.length > 60) out[s] = { closes: d.closes, ts: d.ts };
  });
  return out;
}

async function scoreMatured({ priceLoader = defaultPriceLoader, historyLoader = defaultHistoryLoader } = {}) {
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
  const sigNeed = new Set();
  rows.forEach(r => {
    if (r.outcome != null || r.baseline != null) return;
    const due = Date.parse(r.ts) + r.event.horizon_days * 864e5;
    if (now < due) return;
    const sym = sigmaSymbolOf(r.event);
    if (sym) sigNeed.add(sym);
  });
  const hist = sigNeed.size ? await historyLoader([...sigNeed]).catch(() => ({})) : {};
  let scored = 0;
  for (const r of rows) {
    const due = Date.parse(r.ts) + r.event.horizon_days * 864e5;
    if (now >= due && r.outcome == null) {
      const o = resolveEvent(r.event, px);
      if (o == null) continue;
      r.outcome = o;
      r.resolvedAt = new Date().toISOString();
      scored++;
    }
    // baseline досчитываем и для ранее оценённых строк, где его не было
    if (r.outcome != null && r.baseline == null) {
      const sym = sigmaSymbolOf(r.event);
      const sig = sym ? sigmaBefore(Date.parse(r.ts), hist[sym] || {}) : null;
      const base = baselineProb(r.event, sig);
      if (base != null) r.baseline = +base.toFixed(3);
    }
    if (r.outcome != null && r.informative == null && r.baseline != null) {
      r.informative = Math.abs(r.prob - r.baseline) >= INFORMATIVE_EDGE;
    }
  }
  if (scored) writePreds(rows);
  return scored;
}

// абсолютный Brier (для справки; мера смещения, не навыка)
function brierByRole() {
  const rows = readPreds().filter(r => r.outcome != null && r.informative !== false);
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

// #М7: Brier Skill Score относительно baseline случайного блуждания.
// Отрицательный = агент хуже монетки. Считается по информативным прогнозам.
function bssByRole() {
  const rows = readPreds().filter(r => r.outcome != null && r.informative === true && r.baseline != null);
  const acc = {};
  for (const r of rows) {
    acc[r.role] = acc[r.role] || { bsA: 0, bsB: 0, n: 0 };
    const o = r.outcome ? 1 : 0;
    acc[r.role].bsA += (r.prob - o) ** 2;
    acc[r.role].bsB += (r.baseline - o) ** 2;
    acc[r.role].n++;
  }
  const out = {};
  for (const [role, { bsA, bsB, n }] of Object.entries(acc)) {
    out[role] = bsB > 0 ? { bss: 1 - bsA / bsB, n } : { bss: null, n };
  }
  return out;
}

// веса консенсуса = softmax(BSS); пересчитываются «оптом» каждые 20
// разрешённых прогнозов (bucket), чтобы не дёргаться от каждого исхода.
// Пока информативной истории нет — фолбэк на softmax(−Brier).
function consensusWeights() {
  const bss = bssByRole();
  const eligible = Object.entries(bss).filter(([, v]) => v.n >= 5 && v.bss != null);
  if (!eligible.length) {
    const b = brierByRole();
    const e2 = Object.entries(b).filter(([, v]) => v != null);
    if (!e2.length) return { basis: 'нет истории', weights: {} };
    const exp = Object.fromEntries(e2.map(([r, v]) => [r, Math.exp(-v)]));
    const z = Object.values(exp).reduce((s, v) => s + v, 0);
    return { basis: 'brier (мало информативных прогнозов)', weights: Object.fromEntries(Object.entries(exp).map(([r, v]) => [r, v / z])) };
  }
  const exp = Object.fromEntries(eligible.map(([r, v]) => [r, Math.exp(v.bss)]));
  const z = Object.values(exp).reduce((s, v) => s + v, 0);
  const resolvedN = readPreds().filter(r => r.outcome != null && r.informative !== false).length;
  return {
    basis: 'softmax(BSS)',
    bucket: Math.floor(resolvedN / 20),
    nextRecalcAt: (Math.floor(resolvedN / 20) + 1) * 20,
    weights: Object.fromEntries(Object.entries(exp).map(([r, v]) => [r, v / z])),
  };
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
  baselineProb, sigmaBefore, sigmaSymbolOf,
  runCommittee, scoreMatured, brierByRole, bssByRole, consensusWeights, calibration,
};
