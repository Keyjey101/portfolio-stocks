// #6 журнал решений и контрфактуальная атрибуция:
// решения (автодетект сделок + веб-форма), контрфактуалы против альтернатив,
// точность рекомендаций системы (recs.jsonl против реализованных цен).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DEC_FILE = path.join(ROOT, 'data', 'decisions.jsonl');
const PEND_FILE = path.join(ROOT, 'data', 'trades-pending.json');
const RECS_FILE = path.join(ROOT, 'data', 'recs.jsonl');

const TYPES = ['buy', 'sell', 'skip', 'ignore_advice'];

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

function addDecision({ type, t, qty, price, rationale = '', tags = [] }) {
  if (!TYPES.includes(type)) throw new Error(`type должен быть одним из: ${TYPES.join(' | ')}`);
  const T = String(t || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]*$/.test(T)) throw new Error('некорректный тикер');
  if (!(+qty > 0) && type !== 'skip' && type !== 'ignore_advice') throw new Error('qty должен быть > 0');
  const rec = {
    id: crypto.randomUUID(), ts: new Date().toISOString(),
    type, t: T, qty: Math.round(+qty) || null, price: +price || null,
    rationale: String(rationale).slice(0, 1000), tags: tags.map(String).slice(0, 8),
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

// контрфактуалы: решение старше 30 дней
//   buy/skip → альтернатива «равновес вотчлиста» на ту же дату
//   sell     → альтернатива «держать до сих пор»
async function computeCounterfualsImpl({ decisions, priceLoader, watch = [] }) {
  const out = [];
  const now = Date.now();
  for (const d of decisions) {
    if (Date.now() - Date.parse(d.ts) < 30 * 864e5) continue;
    if (!['buy', 'sell', 'skip'].includes(d.type)) continue;
    const daysAgo = Math.round((now - Date.parse(d.ts)) / 864e5);
    const td = TRADING_DAYS_AFTER(daysAgo);

    const [px0, px1] = await Promise.all([priceLoader(d.t, td), priceLoader(d.t, 0)]);
    if (px0 == null || px1 == null) continue;

    let alternativePct = null, alternativeLabel = null;
    if (d.type === 'sell') {
      alternativeLabel = 'держать до сейчас';
      alternativePct = (px1 / px0 - 1) * 100;
    } else {
      alternativeLabel = 'равновес вотчлиста';
      const parts = [];
      for (const w of watch) {
        const [a, b] = await Promise.all([priceLoader(w, td), priceLoader(w, 0)]);
        if (a != null && b != null) parts.push(b / a - 1);
      }
      if (parts.length) alternativePct = (parts.reduce((s, v) => s + v, 0) / parts.length) * 100;
    }

    const actualPct = d.type === 'sell'
      ? 0 // продано по цене решения: факт зафиксирован
      : (px1 / px0 - 1) * 100;

    out.push({
      id: d.id, ts: d.ts, type: d.type, t: d.t,
      px0, px1, actualPct, alternativePct, alternativeLabel,
      edgePct: alternativePct != null ? actualPct - alternativePct : null,
    });
  }
  return out;
}
const computeCounterfactuals = computeCounterfualsImpl;

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

module.exports = { addDecision, listDecisions, detectTrades, pendingTrades, getPending, resolvePending, computeCounterfactuals, adviceAccuracy };
