// #М3 календарь событий и очередь пересмотров. Система должна знать о
// событиях ЗАРАНЕЕ, а не постфактум по движению цены:
//   T−7 дней до отчёта — позиция помечена, уровни заморожены (правило
//     владельца: не покупать полным траншем перед бинарным событием);
//   T+1 день после — автоматическая цепочка: переоценка тезиса (LLM по
//     отчёту против опор) → переход по правилам машины состояний →
//     перевывод уровней → запись в историю.
// Календарь Yahoo отдаёт только БУДУЩИЕ отчёты, поэтому приближающиеся
// даты складируются в data/reports-watch.json: отчёт «наступил», когда
// его ts прошла, — и тогда запускается цепочка (каждый отчёт один раз).
const fs = require('fs');
const path = require('path');
const { chart } = require('../yahoo');
const { fetchHeadlines } = require('../news');
const { edgarRecent } = require('../edgar');
const { PROMPTS } = require('../prompts');
const defaultLlm = require('../llm');
const theses = require('./theses');

const DAY = 864e5;
const FREEZE_DAYS = 7;    // T−7: заморозка уровней перед отчётом
const CHAIN_AFTER_MS = 12 * 3600e3; // T+~12ч после отчёта — цепочка
const WATCH_FILE = () => process.env.REPORTS_WATCH_FILE
  || path.join(__dirname, '..', '..', 'data', 'reports-watch.json');
const KNOWN_FILE = () => process.env.KNOWN_EVENTS_FILE
  || path.join(__dirname, '..', '..', 'data', 'events-known.json');

const REVIEW_SCHEMA = {
  deterioration: 'boolean',
  recovery_confirmed: 'array',
  damaged_pillars: 'array',
  proposed_state: 'enum:intact,watch,damaged,recovering,dead',
  evidence: 'string',
  eps: 'number', eps_basis: 'string',
  multiple_low: 'number', multiple_high: 'number', multiple_basis: 'string',
  haircut_pct: 'number',
  confirm_event: 'string', confirm_check: 'string',
};

// известные рыночные события (ФОМС и прочие): файл-сидинг, владелец правит
function knownEvents() {
  try {
    const j = JSON.parse(fs.readFileSync(KNOWN_FILE(), 'utf8'));
    if (Array.isArray(j.events)) return j.events.filter(e => e.date && e.label);
  } catch {}
  return [];
}

// ── вотч-файл отчётов: будущие даты складируются, наступившие — в цепочку ──
function readWatch() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCH_FILE(), 'utf8'));
    if (Array.isArray(j.items)) return j;
  } catch {}
  return { updatedAt: null, items: [] };
}

function writeWatch(w) {
  const f = WATCH_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...w, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, f);
}

// добавить будущие отчёты из календаря (идемпотентно по t+ts);
// устаревшие обработанные записи подрезаются (90 дней)
function syncWatch(calendarItems, now = Date.now()) {
  const w = readWatch();
  for (const it of calendarItems || []) {
    if (!it?.t || !it?.ts) continue;
    if (!w.items.some(x => x.t === it.t && x.ts === it.ts)) {
      w.items.push({ t: it.t, ts: it.ts, processedAt: null });
    }
  }
  w.items = w.items.filter(x => x.processedAt == null || now - Date.parse(x.processedAt) < 90 * DAY);
  writeWatch(w);
  return w;
}

// ── чистые помощники ──
// заморожена ли позиция: отчёт ближе FREEZE_DAYS дней
function freezeMark(items, now = Date.now()) {
  const map = {};
  for (const it of items) {
    if (it.processedAt) continue;
    const d = (it.ts - now) / DAY;
    if (d >= 0 && d <= FREEZE_DAYS) map[it.t] = { days: Math.round(d), ts: it.ts };
  }
  return map;
}

// какие тикеры ждут T+1 цепочку: отчёт наступил 12ч–10д назад и не обработан
function dueForChain({ watchItems, now = Date.now() }) {
  const out = [];
  for (const it of watchItems || []) {
    if (it.processedAt) continue;
    const age = now - it.ts;
    if (age < CHAIN_AFTER_MS || age > 10 * DAY) continue;
    out.push({ t: it.t, ts: it.ts, ageHours: Math.round(age / 3600e3) });
  }
  return out;
}

// сводная очередь пересмотров: тезисы (просроченные — красным наверх) +
// отчёты ≤7 дней + сработавшие фальсификации + известные события
async function queueView({ calendarLoader = null, now = new Date() } = {}) {
  const cal = calendarLoader ? await calendarLoader().catch(() => ({ items: [] })) : { items: [] };
  const watch = syncWatch(cal.items || [], now.getTime());
  const soon = watch.items
    .filter(i => !i.processedAt)
    .map(i => ({ t: i.t, ts: i.ts, days: Math.round((i.ts - now.getTime()) / DAY) }))
    .filter(i => i.days >= 0 && i.days <= FREEZE_DAYS);
  const queue = theses.reviewQueue({ now });
  const falsifyTriggered = [];
  try {
    const { getRegistry } = require('./falsify');
    for (const r of getRegistry()) {
      if (r.status === 'triggered') falsifyTriggered.push({ t: r.t, why: 'сработало условие фальсификации' });
    }
  } catch {}
  return {
    generatedAt: now.toISOString(),
    queue,
    soon,
    falsifyTriggered,
    known: knownEvents().map(e => ({ ...e, days: Math.round((Date.parse(e.date + 'T12:00:00') - now.getTime()) / DAY) }))
      .filter(e => e.days >= 0 && e.days <= 60),
    freeze: freezeMark(watch.items, now.getTime()),
  };
}

// ── T+1 цепочка по одному тикеру ──
// детектор-классификация не повторяется (его уже считает дневной прогрев),
// здесь — сверка отчёта с тезисом, переход по правилам, перевывод уровней.
async function runEarningsChain(T, { llm = defaultLlm, watchItem = null, store = theses, derivator = null, now = new Date() } = {}) {
  const t = String(T || '').toUpperCase().trim();
  const rec = store.get(t);
  if (!rec) throw new Error(`${t}: нет записи тезиса — цепочке нечего переоценивать`);

  const d = await chart(t, '5d').catch(() => null);
  const px = d?.price ?? (d?.closes?.length ? d.closes.at(-1) : null);
  const dayMove = d?.closes?.length >= 2 ? (d.closes.at(-1) / d.closes.at(-2) - 1) : null;
  const [news, filings] = await Promise.all([
    fetchHeadlines(t).catch(() => []),
    edgarRecent(t).catch(() => []),
  ]);

  const reportTs = watchItem?.ts;
  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.thesisReview.system },
     { role: 'user', content: PROMPTS.thesisReview.user({
       rec, earnings: reportTs ? { date: new Date(reportTs).toISOString().slice(0, 10) } : {},
       px, dayMove, news, filings }) }],
    { schema: REVIEW_SCHEMA, task: 'thesis-review', t, temperature: 0.15 },
  );

  const { runDerive } = require('./derivation');
  const derive = derivator || runDerive;
  // якоря из той же сверки: перевывод без второго LLM-вызова (бюджет)
  const anchors = (+v.eps > 0 && +v.multiple_low > 0)
    ? { eps: +v.eps, eps_basis: v.eps_basis, multiple_low: +v.multiple_low, multiple_high: +v.multiple_high,
        multiple_basis: v.multiple_basis, haircut_pct: +v.haircut_pct || 0,
        confirm_event: v.confirm_event, confirm_check: v.confirm_check }
    : null;

  const r = await store.applyEvent(t, {
    kind: 'earnings', source: 'earnings', trigger: 'earnings',
    deterioration: !!v.deterioration,
    recovery_confirmed: (v.recovery_confirmed || []).filter(i => Number.isInteger(i)),
    damaged_pillars: v.damaged_pillars || [],
    proposal: { state: v.proposed_state, note: v.evidence },
    evidence: v.evidence,
  }, { derive: anchors ? () => derive(t, { anchors }) : derive });

  // отметка «отчёт обработан» + следующий дедлайн пересмотра:
  // следующий известный отчёт, иначе +90 дней
  const w = readWatch();
  const nextCal = w.items.find(i => i.t === t && !i.processedAt && i.ts > now.getTime());
  const next = { ...r.rec };
  next.earnings = { ts: reportTs ?? now.getTime(), processedAt: now.toISOString() };
  if (['damaged', 'watch', 'recovering'].includes(next.state)) {
    next.review = {
      due: nextCal ? new Date(nextCal.ts).toISOString().slice(0, 10)
        : new Date(now.getTime() + 90 * DAY).toISOString().slice(0, 10),
      reason: nextCal ? 'следующий отчёт' : 'пересмотр по умолчанию (90 дней)',
    };
  }
  store.saveRecord(next);

  return {
    t, verdict: v, transition: r.transition, derivation: r.derivation,
    state: next.state, review: next.review || null, processedAt: next.earnings.processedAt,
  };
}

// обход всех дозревших отчётов (планировщик, раз в день; каждый — один раз)
async function runDueChains({ llm = defaultLlm, calendarLoader = null, store = theses, now = new Date() } = {}) {
  const cal = calendarLoader ? await calendarLoader().catch(() => ({ items: [] })) : { items: [] };
  const w = syncWatch(cal.items || [], now.getTime());
  const due = dueForChain({ watchItems: w.items, now: now.getTime() });
  const out = [];
  for (const d of due) {
    try {
      const res = await runEarningsChain(d.t, { llm, watchItem: d, store, now });
      out.push(res);
    } catch (e) {
      out.push({ t: d.t, error: e.message });
      // без записи тезиса цепочка не встанет — помечаем обработанным,
      // чтобы не крутить попытки ежедневно (детектор всё равно следит)
      if (/нет записи тезиса/.test(e.message)) {
        const w2 = readWatch();
        const it = w2.items.find(x => x.t === d.t && x.ts === d.ts);
        if (it) { it.processedAt = now.toISOString(); it.error = e.message; writeWatch(w2); }
      }
    }
  }
  // финальная отметка обработки (после успешной цепочки)
  const w3 = readWatch();
  for (const r of out) {
    if (r.error) continue;
    const it = w3.items.find(x => x.t === r.t && !x.processedAt && x.ts <= now.getTime());
    if (it) it.processedAt = r.processedAt;
  }
  writeWatch(w3);
  return { ran: out.length, results: out };
}

module.exports = { knownEvents, readWatch, syncWatch, freezeMark, dueForChain, queueView, runEarningsChain, runDueChains };
