// #6/#М8 журнал решений и контрфактуальная атрибуция:
// решения (автодетект сделок + веб-форма) со снапшотом состояния тезиса
// на момент решения; контрфактуалы на 30/90/365 дней против «ничего не
// делать», равновесного вотчлиста и ITOT; TWR портфеля по ряду NAV
// (тайминг довнесений не искажает сравнение с бенчмарком); точность
// рекомендаций самой системы (детектор + сработавшие уровни).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DEC_FILE = path.join(ROOT, 'data', 'decisions.jsonl');
const PEND_FILE = path.join(ROOT, 'data', 'trades-pending.json');
const RECS_FILE = path.join(ROOT, 'data', 'recs.jsonl');
// NAV-ряд можно переопределить (NAV_FILE) — тесты гоняют файлы параллельно
const NAV_FILE = () => process.env.NAV_FILE || path.join(ROOT, 'data', 'nav.jsonl');

const TYPES = ['buy', 'sell', 'skip', 'ignore_advice', 'contribution'];
const CF_HORIZONS = [30, 90, 365];

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

// снапшот тезиса на момент решения: состояние + действующие уровни
function thesisSnapshot(T) {
  try {
    const rec = require('./theses').get(String(T || '').toUpperCase());
    if (!rec) return null;
    return {
      state: rec.state,
      levels: rec.levels ? { t1: rec.levels.t1, t2: rec.levels.t2, t3: rec.levels.t3 } : null,
      damaged_pillars: rec.damaged_pillars || [],
    };
  } catch { return null; }
}

function addDecision({ type, t, qty, price, rationale = '', tags = [] }) {
  if (!TYPES.includes(type)) throw new Error(`type должен быть одним из: ${TYPES.join(' | ')}`);
  const T = String(t || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]*$/.test(T) && type !== 'contribution') throw new Error('некорректный тикер');
  if (!(+qty > 0) && type !== 'skip' && type !== 'ignore_advice') throw new Error('qty должен быть > 0');
  const rec = {
    id: crypto.randomUUID(), ts: new Date().toISOString(),
    type, t: T || null, qty: Math.round(+qty) || null, price: +price || null,
    rationale: String(rationale).slice(0, 1000), tags: tags.map(String).slice(0, 8),
    thesis: type !== 'contribution' ? thesisSnapshot(T) : null,
  };
  appendJsonl(DEC_FILE, rec);
  return rec;
}

const listDecisions = () => readJsonl(DEC_FILE);

// дифф снапшотов позиций Tradernet → список сделок
function detectTrades(prev, next) {
  const map = new Map(next.map(p => [p.t, p.qty]));
  const out = [];
  for (const p of prev) {
    const q = map.get(p.t) ?? 0;
    if (q !== p.qty) out.push({ t: p.t, prevQty: p.qty, qty: q, dQty: q - p.qty });
    map.delete(p.t);
  }
  for (const [t, q] of map) if (q > 0) out.push({ t, prevQty: 0, qty: q, dQty: q });
  return out;
}

// отложить обнаруженные сделки до объяснения; идемпотентно для одного набора
function pendingTrades(diffs) {
  if (!diffs.length) {
    try {
      const p = JSON.parse(fs.readFileSync(PEND_FILE, 'utf8'));
      if (p && p.resolved) return { diffs: [] };
      return p || { diffs: [] };
    } catch { return { diffs: [] }; }
  }
  try {
    const p = JSON.parse(fs.readFileSync(PEND_FILE, 'utf8'));
    if (p && !p.resolved && JSON.stringify(p.diffs) === JSON.stringify(diffs)) return p;
  } catch { /* нет файла — создадим */ }
  const rec = { id: crypto.randomUUID(), ts: new Date().toISOString(), diffs, resolved: false };
  fs.mkdirSync(path.dirname(PEND_FILE), { recursive: true });
  fs.writeFileSync(PEND_FILE, JSON.stringify(rec, null, 2));
  return rec;
}

function getPending() {
  try {
    const p = JSON.parse(fs.readFileSync(PEND_FILE, 'utf8'));
    return p && !p.resolved ? p : { diffs: [] };
  } catch { return { diffs: [] }; }
}

// объяснить сделку → решение в журнал, pending закрыт
function resolvePending(id, decision) {
  const p = getPending();
  if (!p.id || p.id !== id) return false;
  const d = addDecision(decision);
  fs.writeFileSync(PEND_FILE, JSON.stringify({ ...p, resolved: true, resolvedAs: d.id }, null, 2));
  return true;
}

const TRADING_DAYS_AFTER = d => Math.max(1, Math.round(d / 1.4)); // календарные → торговые

// контрфактуалы (#М8): на КАЖДОЙ созревшей отметке 30/90/365 дней сравниваем
// решение с альтернативами — «держать» (для sell), равновесный вотчлист и
// ITOT. Доходность одной доли = time-weighted по определению (один поток).
async function computeCounterfualsImpl({ decisions, priceLoader, watch = [] }) {
  const out = [];
  const now = Date.now();
  for (const d of decisions) {
    if (!['buy', 'sell', 'skip'].includes(d.type)) continue;
    const daysAgo = Math.round((now - Date.parse(d.ts)) / 864e5);
    if (daysAgo < 30) continue;
    const tdDecision = TRADING_DAYS_AFTER(daysAgo);
    const px0 = await priceLoader(d.t, tdDecision).catch(() => null);
    if (px0 == null) continue;

    const horizons = [];
    for (const h of CF_HORIZONS) {
      if (daysAgo < h) continue;
      const tdHorizon = TRADING_DAYS_AFTER(daysAgo - h);
      const [pxH, itot0, itotH] = await Promise.all([
        priceLoader(d.t, tdHorizon).catch(() => null),
        priceLoader('ITOT', tdDecision).catch(() => null),
        priceLoader('ITOT', tdHorizon).catch(() => null),
      ]);
      if (pxH == null) continue;
      const actual = d.type === 'sell' ? 0 : (pxH / px0 - 1) * 100;
      const hold = d.type === 'sell' ? (pxH / px0 - 1) * 100 : null;
      const watchParts = [];
      for (const w of watch) {
        const [a, b] = await Promise.all([priceLoader(w, tdDecision).catch(() => null), priceLoader(w, tdHorizon).catch(() => null)]);
        if (a != null && b != null) watchParts.push(b / a - 1);
      }
      const watchPct = watchParts.length ? (watchParts.reduce((s, v) => s + v, 0) / watchParts.length) * 100 : null;
      const itotPct = itot0 != null && itotH != null ? (itotH / itot0 - 1) * 100 : null;
      horizons.push({
        h,
        actualPct: actual,
        holdPct: hold,
        watchPct,
        itotPct,
        edgePct: watchPct != null ? actual - watchPct : null,
      });
    }
    if (horizons.length) out.push({ id: d.id, ts: d.ts, type: d.type, t: d.t, px0, daysAgo, horizons });
  }
  return out;
}
const computeCounterfactuals = computeCounterfualsImpl;

// ── TWR (#М8): доходность, взвешенная по времени, по ряду NAV и потокам ──
// nav: [{date:'YYYY-MM-DD', total}]; flows: [{date, usd}] (довнесения >0).
// NAV на дату потока уже включает его: на границе сегмента поток вычитается —
// и как конец предыдущего, и как начало следующего (рыночная часть без ввода)
function twr(nav, flows = []) {
  const pts = [...(nav || [])].filter(p => p.date && Number.isFinite(+p.total)).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 2) return null;
  const navAt = date => {
    let v = null;
    for (const p of pts) { if (p.date <= date) v = +p.total; else break; }
    return v;
  };
  const flowOn = date => flows.filter(f => f.date === date).reduce((s, f) => s + (+f.usd || 0), 0);
  const cutSet = new Set([pts[0].date, pts.at(-1).date]);
  for (const f of flows) if (f.date > pts[0].date && f.date < pts.at(-1).date) cutSet.add(f.date);
  const cuts = [...cutSet].sort();
  let val = 1, segs = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = navAt(cuts[i]) - flowOn(cuts[i]);
    const b = navAt(cuts[i + 1]) - flowOn(cuts[i + 1]);
    if (!(a > 0) || !(b > 0)) continue;
    val *= b / a;
    segs++;
  }
  if (!segs) return null;
  return { value: val - 1, since: pts[0].date, until: pts.at(-1).date, segments: segs };
}

// дневной снапшот стоимости позиций (планировщик) → data/nav.jsonl
function appendNav(total, date = new Date()) {
  const d = (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10);
  const rows = readJsonl(NAV_FILE()).filter(r => r.date !== d); // один снапшот в день
  rows.push({ date: d, total: +total, ts: new Date().toISOString() });
  fs.mkdirSync(path.dirname(NAV_FILE()), { recursive: true });
  fs.writeFileSync(NAV_FILE(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const listNav = () => readJsonl(NAV_FILE());
const navFlowsFromDecisions = decisions =>
  decisions.filter(d => d.type === 'contribution' && d.qty > 0 && d.ts)
    .map(d => ({ date: d.ts.slice(0, 10), usd: d.qty }));

// точность советов: detector thesis_damage → цена через 30 дней ниже?
async function adviceAccuracy({ recs = null, priceLoader }) {
  const rows = (recs || readJsonl(RECS_FILE))
    .filter(r => r.kind === 'detector' && r.verdict === 'thesis_damage')
    .filter(r => Date.now() - Date.parse(r.ts) >= 30 * 864e5);
  let n = 0, hits = 0, retSum = 0;
  for (const r of rows) {
    const td = TRADING_DAYS_AFTER(Math.round((Date.now() - Date.parse(r.ts)) / 864e5));
    const [a, b] = await Promise.all([priceLoader(r.t, td), priceLoader(r.t, 0)]);
    if (a == null || b == null) continue;
    const ret = (b / a - 1) * 100;
    n++;
    retSum += ret;
    if (ret < 0) hits++;
  }
  return { n, hits, meanRet: n ? retSum / n : null };
}

// точность уровней (#М8): сколько выведенных сеток коснулась цена за 90 дней
// и какой была доходность через 30 торговых дней после касания самого
// глубокого достигнутого уровня («уровень сработал выгодно»)
async function levelsAccuracy({ items = null, seriesLoader }) {
  const recs = Object.values(items || require('./theses').listAll());
  const out = [];
  for (const rec of recs) {
    for (const h of rec.levels_history || []) {
      const ageDays = (Date.now() - Date.parse(h.ts)) / 864e5;
      if (ageDays < 90) continue;
      const closes = await seriesLoader(rec.t).catch(() => null);
      if (!closes || closes.length < 60) continue;
      const i0 = Math.max(0, closes.length - 1 - TRADING_DAYS_AFTER(ageDays));
      const window = closes.slice(i0);
      if (window.length < 10) continue;
      // самый глубокий достигнутый уровень сетки (T3 → T1)
      for (const lv of [h.t3, h.t2, h.t1]) {
        if (!(lv > 0)) continue;
        const touchIdx = window.findIndex(c => c <= lv);
        if (touchIdx < 0) continue;
        const after = window.slice(touchIdx, touchIdx + 31);
        if (after.length < 6) continue; // касание слишком свежее — не оцениваем
        out.push({ t: rec.t, ts: h.ts, level: lv, retAfter30: after.at(-1) / after[0] - 1 });
        break;
      }
    }
  }
  const good = out.filter(x => x.retAfter30 > 0).length;
  return { n: out.length, good, meanRet: out.length ? out.reduce((s, x) => s + x.retAfter30, 0) / out.length : null };
}

module.exports = {
  addDecision, listDecisions, detectTrades, pendingTrades, getPending, resolvePending,
  computeCounterfactuals, adviceAccuracy, levelsAccuracy,
  twr, appendNav, listNav, navFlowsFromDecisions, CF_HORIZONS,
};
