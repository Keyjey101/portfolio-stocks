// #М1 машина состояний тезиса: intact → watch → damaged → recovering → dead.
// Метки «⛔ не добирать» больше не статичны в META — состояние живёт здесь,
// поддерживается автоматическими триггерами (детектор, фальсификации, отчёты)
// и ручными переходами с обязательным обоснованием. Полная история переходов
// и перевыводов уровней пишется в data/theses.json (версионируется git-ом
// владельцем по желанию; файл атомарный, tmp+rename).
//
// Чистая часть — nextState/reduce (переходы по правилам мандата); I/O — ниже.
const fs = require('fs');
const path = require('path');

const STATES = ['intact', 'watch', 'damaged', 'recovering', 'dead'];
const FILE = () => process.env.THESES_FILE || path.join(__dirname, '..', '..', 'data', 'theses.json');
const DAY = 864e5;
const LEVELS_HISTORY_CAP = 20;

// ── Правила переходов (спецификация «Модуль 1») ──
// Возвращает { to, changed } или null, если событие состояние не меняет.
// proposal LLM (proposed_state) здесь НЕ решает — решают правила и confidence.
function nextState(state, ev) {
  if (!STATES.includes(state)) return null;
  switch (ev.kind) {
    case 'damage_strong':   // detector thesis_damage, confidence > 0.6
      return ['intact', 'watch', 'recovering'].includes(state)
        ? { to: 'damaged', changed: true } : null;
    case 'damage_weak':     // confidence 0.4–0.6
      if (state === 'intact' || state === 'recovering') return { to: 'watch', changed: true };
      return null;
    case 'falsify_hard':    // условие фальсификации сработало, жёсткое
      return state === 'dead' ? null : { to: 'dead', changed: true };
    case 'falsify_soft':    // мягкое условие — тезис повреждён, не мёртв
      return ['dead'].includes(state) ? null : { to: 'damaged', changed: true };
    case 'recovery_confirmed': // в recovering подтверждены ВСЕ recovery_conditions
      return state === 'recovering' ? { to: 'intact', changed: true } : null;
    case 'earnings':        // отчёт вышел — см. reduce (нужны счётчики записи)
    case 'manual':          // ручной переход проверяется в applyManual
      return null;
    default:
      return null;
  }
}

// отчёт вышел: переоценка с учётом счётчика «чистых» отчётов.
// damaged + два отчёта подряд без ухудшения → recovering;
// watch + отчёт без ухудшения → intact (подтверждение сняло сигнал);
// recovering + все recovery_conditions подтверждены → intact.
function earningsTransition(rec, ev) {
  const s = rec.state;
  if (s === 'dead') return null;
  if (s === 'damaged') {
    if (ev.deterioration) return { to: 'damaged', resetClean: true };
    const cleans = (rec.clean_reports || 0) + 1;
    if (cleans >= 2) return { to: 'recovering', cleans };
    return { to: 'damaged', cleans };
  }
  if (s === 'watch') {
    return ev.deterioration
      ? { to: 'damaged' }
      : { to: 'intact' };
  }
  if (s === 'recovering') {
    const total = (rec.recovery_conditions || []).length;
    const confirmed = (ev.recovery_confirmed || []).length;
    if (total > 0 && confirmed >= total) return { to: 'intact' };
    return null;
  }
  return null; // intact: отчёт без сигналов ничего не меняет
}

// в каких состояниях перевыводятся уровни при переходе в них
const NEEDS_DERIVATION = ['damaged', 'recovering', 'dead', 'intact'];

// ── Редьюсер записи: событие → новая запись + переход в историю ──
// Чистая функция: rec не мутируется. ev = {
//   kind, source: 'detector|falsify|earnings|manual|system',
//   trigger, evidence, confidence, pillar, deterioration,
//   recovery_confirmed: [idx…], damaged_pillars: […], to (manual),
//   proposal: { state, note } — мнение LLM рядом с решением правил }
function reduce(rec, ev, now = new Date()) {
  const iso = now.toISOString();
  let tr = null;
  if (ev.kind === 'earnings') {
    tr = earningsTransition(rec, ev);
  } else if (ev.kind === 'manual') {
    if (!STATES.includes(ev.to)) throw new Error(`неизвестное состояние: ${ev.to}`);
    if (ev.to !== rec.state) tr = { to: ev.to };
  } else {
    tr = nextState(rec.state, ev);
  }
  if (!tr || (tr.to === rec.state && !tr.resetClean && tr.cleans == null && !tr.forceLog)) {
    // перехода нет — фиксируем только предложение LLM, если пришло
    if (!ev.proposal) return { rec, transition: null };
    return {
      rec: { ...rec, proposed: { state: ev.proposal.state, by: ev.source, at: iso, note: ev.proposal.note || '' }, updated_at: iso },
      transition: null,
    };
  }

  const from = rec.state;
  const to = tr.to;
  const out = { ...rec, state: to, updated_at: iso };

  // счётчик чистых отчётов в damaged
  if (ev.kind === 'earnings') {
    out.clean_reports = tr.resetClean ? 0 : (tr.cleans != null ? tr.cleans : out.clean_reports || 0);
  } else if (to !== 'damaged') {
    out.clean_reports = 0;
  }

  // опоры: событие может уточнить список задетых
  if (ev.damaged_pillars && to === 'damaged') out.damaged_pillars = [...new Set([...(rec.damaged_pillars || []), ...ev.damaged_pillars])];
  if (to === 'intact' || to === 'recovering') out.damaged_pillars = [];
  if (ev.pillar && to === 'damaged') out.damaged_pillars = [...new Set([...(rec.damaged_pillars || []), ev.pillar])];

  // уровни: при damaged/dead старые аннулируются; intact после recovering — перевывод
  if (to === 'damaged' || to === 'dead') {
    out.levels = null;
  } else if (from === 'recovering' && to === 'intact') {
    out.levels = null; // ПЕРЕВЫВОД обязателен
  }

  // пересмотр: damaged/watch не должны висеть вечно — дедлайн по умолчанию 90 дней,
  // календарная цепочка уточнит его датой следующего отчёта
  if (to === 'damaged' || to === 'watch' || to === 'recovering') {
    if (!out.review || !out.review.due) {
      out.review = { due: new Date(now.getTime() + 90 * DAY).toISOString().slice(0, 10), reason: 'пересмотр по умолчанию (90 дней)' };
    }
  } else if (to === 'intact' || to === 'dead') {
    out.review = null;
  }
  if (to === 'dead' && !out.exit_plan) {
    out.exit_plan = { target: null, deadline: null, note: 'план выхода не сформирован — запусти перевывод уровней' };
  }
  if (ev.proposal) out.proposed = { state: ev.proposal.state, by: ev.source, at: iso, note: ev.proposal.note || '' };
  else if (out.proposal) out.proposal = undefined;

  out.history = [...(rec.history || []), {
    date: iso, from, to,
    trigger: ev.trigger || ev.kind,
    evidence: String(ev.evidence || '').slice(0, 400),
    source: ev.source || 'system',
  }];

  return { rec: out, transition: { from, to, needsDerivation: NEEDS_DERIVATION.includes(to) && !out.levels } };
}

// ── I/O: хранилище data/theses.json ──
function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (j && typeof j.items === 'object') return j;
  } catch {}
  return { updatedAt: new Date().toISOString(), items: {} };
}

function saveStore(store) {
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
  return store;
}

const all = () => readStore().items;
const get = t => readStore().items[String(t || '').toUpperCase()] || null;

function saveRecord(rec) {
  const store = readStore();
  store.items[rec.t] = rec;
  saveStore(store);
  return rec;
}

// ── Сидинг из META (+ реестр фальсификаций, если тезисы уже сформулированы) ──
// st:'broken' → damaged, st:'sell' → dead; остальным позициям с уровнями — intact.
// Не трогает существующие записи — сидинг идемпотентен.
function seedFromMeta({ meta, registry = [], now = new Date() } = {}) {
  const M = meta || require('../portfolio').META;
  let reg = registry;
  try { reg = registry.length ? registry : require('./falsify').getRegistry(); } catch {}
  const store = readStore();
  const iso = now.toISOString();
  for (const [t, m] of Object.entries(M)) {
    if (store.items[t]) continue;
    const fals = reg.find(r => r.t === t);
    const state = m.st === 'broken' ? 'damaged' : m.st === 'sell' ? 'dead' : 'intact';
    const rec = {
      t, state,
      thesis: fals?.thesis || m.note || '',
      pillars: [], damaged_pillars: [],
      history: [{
        date: iso, from: null, to: state,
        trigger: 'seed', evidence: `сидинг из META (st:${m.st || '—'})`, source: 'system',
      }],
      levels: null, levels_history: [],
      recovery_conditions: m.check ? [m.check] : [],
      clean_reports: 0,
      created_at: iso, updated_at: iso,
    };
    if (m.reviewBy) rec.review = { due: m.reviewBy, reason: m.check || 'пересмотр из META' };
    if (fals?.conditions) rec.recovery_conditions = fals.conditions.map(c => c.text);
    store.items[t] = rec;
  }
  saveStore(store);
  return store;
}

// ленивое чтение без сидинга + безопасный сидинг при первом обращении
let seeded = false;
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  try { seedFromMeta({}); } catch { /* нет записи в data/ — сидинг повторится, состояние не критично */ }
}

const listAll = () => { ensureSeeded(); return all(); };
const getOrSeed = t => { ensureSeeded(); return get(t); };

// ── Применение события с перевыводом уровней ──
// derive — инъекция (src/lab/derivation.js runDerive), чтобы не тянуть цикл
// require на загрузке модулей. Без derive переход всё равно пишется.
async function applyEvent(T, ev, { derive = null, now = new Date() } = {}) {
  ensureSeeded();
  const t = String(T || '').toUpperCase().trim();
  const cur = get(t);
  if (!cur) throw new Error(`${t}: нет записи тезиса (сначала сгенерируй фальсификации или добавь позицию)`);
  const { rec, transition } = reduce(cur, ev, now);
  saveRecord(rec);
  let derivation = null;
  if (transition?.needsDerivation && derive) {
    derivation = await derive(t).catch(e => ({ error: e.message }));
  }
  return { rec, transition, derivation };
}

// ручной переход: всегда можно, но с обоснованием (пишется в history)
async function applyManual(T, to, reason, opts = {}) {
  if (!STATES.includes(to)) throw new Error(`состояние должно быть одним из: ${STATES.join(' | ')}`);
  if (!reason || String(reason).trim().length < 10) throw new Error('ручной переход требует обоснования (мин. 10 символов) — оно попадёт в историю');
  return applyEvent(T, { kind: 'manual', to, source: 'manual', trigger: 'manual', evidence: String(reason).trim() }, opts);
}

// синхронизация из реестра фальсификаций: тезис/опоры/условия восстановления.
// Создаёт запись (state intact), если её ещё нет; состояние не трогает.
function syncFromFalsify(T, { thesis, pillars = [], recovery_conditions = [] }) {
  ensureSeeded();
  const t = String(T || '').toUpperCase().trim();
  const store = readStore();
  const iso = new Date().toISOString();
  const cur = store.items[t];
  if (!cur) {
    store.items[t] = {
      t, state: 'intact',
      thesis: thesis || '', pillars: pillars.slice(0, 4), damaged_pillars: [],
      history: [{ date: iso, from: null, to: 'intact', trigger: 'seed', evidence: 'тезис зарегистрирован через реестр фальсификаций', source: 'falsify' }],
      levels: null, levels_history: [],
      recovery_conditions: recovery_conditions.slice(0, 3),
      clean_reports: 0, created_at: iso, updated_at: iso,
    };
  } else {
    store.items[t] = {
      ...cur,
      thesis: thesis || cur.thesis,
      pillars: pillars.length ? pillars.slice(0, 4) : cur.pillars,
      recovery_conditions: recovery_conditions.length ? recovery_conditions.slice(0, 3) : cur.recovery_conditions,
      updated_at: iso,
    };
  }
  saveStore(store);
  return store.items[t];
}

// ── Очередь пересмотров (вход в Модуль 3) ──
// priority: 0 просрочен пересмотр (красный верх) · 1 сработала фальсификация ·
// 2 отчёт ≤7 дней · 3 damaged/watch без пересмотра >90 дней
function reviewQueue({ items = null, now = new Date() } = {}) {
  const recs = Object.values(items || listAll());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (const r of recs) {
    if (r.state === 'intact' && !r.review?.due) continue;
    const dueDays = r.review?.due
      ? Math.round((today - Date.parse(r.review.due + 'T00:00:00')) / DAY)
      : null;
    const lastTouch = r.history?.length ? Date.parse(r.history.at(-1).date) : Date.parse(r.updated_at || r.created_at || '');
    const staleDays = Number.isFinite(lastTouch) ? Math.round((now - lastTouch) / DAY) : null;
    if (dueDays != null && dueDays > 0) {
      out.push({ t: r.t, state: r.state, priority: 0, dueDays, why: `пересмотр просрочен на ${dueDays} дн (был к ${r.review.due})` });
    } else if (r.state === 'dead' && !r.exit_plan?.deadline) {
      out.push({ t: r.t, state: r.state, priority: 1, dueDays: null, why: 'тезис мёртв — план выхода не сформирован' });
    } else if (r.review?.due) {
      const inDays = -dueDays;
      out.push({ t: r.t, state: r.state, priority: inDays <= 7 ? 2 : 3, dueDays: inDays, why: `пересмотр к ${r.review.due}${r.review.reason ? ' — ' + r.review.reason : ''}` });
    } else if ((r.state === 'damaged' || r.state === 'watch') && staleDays != null && staleDays > 90) {
      out.push({ t: r.t, state: r.state, priority: 3, dueDays: staleDays, why: `${r.state} без пересмотра ${staleDays} дн` });
    }
  }
  out.sort((a, b) => a.priority - b.priority || (a.dueDays ?? 0) - (b.dueDays ?? 0));
  return out;
}

// просрочен ли пересмотр (для статуса позиции в терминале)
const reviewOverdue = (r, now = new Date()) =>
  !!(r?.review?.due && Date.parse(r.review.due + 'T00:00:00') < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime());

module.exports = {
  STATES, nextState, earningsTransition, reduce,
  readStore, saveStore, seedFromMeta, listAll, getOrSeed, get, all, saveRecord,
  applyEvent, applyManual, syncFromFalsify, reviewQueue, reviewOverdue,
};
