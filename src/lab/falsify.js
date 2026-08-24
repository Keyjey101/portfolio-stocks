// #3 реестр фальсификаций (Поппер для портфеля): при покупке LLM генерирует
// 3 фальсифицируемых условия «тезис мёртв, если…»; агент проверяет их
// ежеквартально по отчётам и новостям. Триггер → позиция помечается.
const fs = require('fs');
const path = require('path');
const { META, WATCH } = require('../portfolio');
const overrides = require('../overrides');
const { fetchHeadlines } = require('../news');
const { PROMPTS } = require('../prompts');
const { edgarRecent } = require('../edgar');
const { chart } = require('../yahoo');
const defaultLlm = require('../llm');

const REG_FILE = path.join(__dirname, '..', '..', 'data', 'falsifications.json');

function getRegistry() {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch { return []; }
}

function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(REG_FILE), { recursive: true });
  const tmp = REG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REG_FILE);
  return reg;
}

const GEN_SCHEMA = {
  thesis: 'string',
  conditions: 'array',
  levels: 'array',
  until_event: 'string',
  until_check: 'string',
};

const CHECK_SCHEMA = {
  verdicts: 'array',
  levels: 'array',
  until_event: 'string',
  until_check: 'string',
};

// текущая цена тикера (для контекста и границ уровней)
async function currentPx(T) {
  const d = await chart(T).catch(() => null);
  if (!d) return null;
  return d.price ?? (d.closes?.length ? d.closes.at(-1) : null);
}

// дефолт меты тикера: позиция из META или watch-строка (для ватчлиста тоже)
function defaultMeta(T) {
  if (META[T]) return META[T];
  const w = WATCH.find(x => x.t === T);
  return w ? { tag: 'watch', lv: w.lv ?? null, note: w.note || '' } : {};
}

// из ответа LLM — патч меты (только whitelist, всё невалидное отбрасывается)
const JUNK_NOTE = /(отсутств|нет данных|недостаточн|не предоставл|не удалось|no info|no data|cannot)/i;
function agentMetaPatch(v, px) {
  const patch = {};
  const lv = overrides.validLv(v.levels, px);
  if (lv) patch.lv = lv;
  const until = overrides.validUntil(v.until_event, v.until_check);
  if (until) patch.until = until;
  const note = typeof v.note === 'string' ? v.note.trim() : '';
  if (note.length > 3 && note.length <= 200 && !JUNK_NOTE.test(note)) patch.note = note;
  return patch;
}

// применяет патч как оверрайд, снимая «было» с эффективной меты
function saveAgentMeta(T, meta, v, px, task) {
  const patch = agentMetaPatch(v, px);
  if (!Object.keys(patch).length) return null;
  const was = { lv: meta.lv ?? null, until: meta.until ?? null, note: meta.note ?? '' };
  const saved = overrides.set(T, { ...patch, _was: was }, task);
  return { ...patch, at: saved._at };
}

// сгенерировать/перегенерировать фальсификации для тикера
async function generate(t, { llm = defaultLlm } = {}) {
  const T = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(T)) throw new Error('введи тикер латиницей, например TSM');
  const meta = overrides.merged(T, defaultMeta(T));
  const [news, filings, px] = await Promise.all([
    fetchHeadlines(T).catch(() => []),
    edgarRecent(T).catch(() => []),
    currentPx(T),
  ]);
  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.falsifyGenerate.system },
     { role: 'user', content: PROMPTS.falsifyGenerate.user({ T, meta, px, news, filings }) }],
    { schema: GEN_SCHEMA, task: 'falsify-generate', t: T, temperature: 0.3 },
  );

  const conds = (v.conditions || [])
    .map(c => (typeof c === 'string' ? { text: c } : c))
    .filter(c => c.text && String(c.text).length > 8)
    .slice(0, 3);
  if (conds.length < 3) throw new Error(`${T}: сгенерировано ${conds.length} условий вместо 3`);

  const agentMeta = saveAgentMeta(T, meta, v, px, 'falsify-generate');
  const reg = getRegistry().filter(r => r.t !== T);
  const rec = {
    t: T, thesis: v.thesis, conditions: conds,
    createdAt: new Date().toISOString(), status: 'active',
    checks: [],
  };
  if (agentMeta) rec.agentMeta = agentMeta;
  reg.push(rec);
  saveRegistry(reg);
  return rec;
}

// проверить условия по свежим данным; триггер → статус triggered + таймер
async function check(t, { llm = defaultLlm } = {}) {
  const T = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(T)) throw new Error('некорректный тикер');
  const reg = getRegistry();
  const idx = reg.findIndex(r => r.t === T);
  if (idx < 0) throw new Error(`${T}: нет записи в реестре фальсификаций`);
  const rec = reg[idx];
  if (!rec.conditions?.length) throw new Error(`${T}: пустой список условий`);

  const [news, filings, px] = await Promise.all([
    fetchHeadlines(T).catch(() => []),
    edgarRecent(T).catch(() => []),
    currentPx(T),
  ]);
  const meta = overrides.merged(T, defaultMeta(T));
  const v = await llm.chat(
    [{ role: 'system', content: PROMPTS.falsifyCheck.system },
     { role: 'user', content: PROMPTS.falsifyCheck.user({ T, thesis: rec.thesis, meta, px, conditions: rec.conditions, news, filings }) }],
    { schema: CHECK_SCHEMA, task: 'falsify-check', t: T, temperature: 0.1 },
  );

  const verdicts = (v.verdicts || [])
    .filter(x => Number.isInteger(x.i) && x.i >= 0 && x.i < rec.conditions.length)
    .map(x => ({ i: x.i, triggered: !!x.triggered, evidence: String(x.evidence || '').slice(0, 400) }));
  rec.checks.push({ date: new Date().toISOString(), verdicts });
  if (verdicts.some(x => x.triggered) && rec.status === 'active') {
    rec.status = 'triggered';
    rec.triggeredAt = new Date().toISOString();
  }
  const agentMeta = saveAgentMeta(T, meta, v, px, 'falsify-check');
  if (agentMeta) rec.agentMeta = agentMeta;
  reg[idx] = rec;
  saveRegistry(reg);
  return rec;
}

// вернуть hardcoded-дефолт: убрать оверрайд агента
function reset(t) {
  const T = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(T)) throw new Error('некорректный тикер');
  return overrides.clear(T);
}

// ежеквартальный обход активных записей (cooldown 89 дней на запись)
async function checkAll({ llm = defaultLlm, cooldownDays = 89 } = {}) {
  const reg = getRegistry();
  const out = [];
  for (const rec of reg) {
    const last = rec.checks?.at(-1)?.date;
    if (last && Date.now() - Date.parse(last) < cooldownDays * 864e5) continue;
    try { out.push(await check(rec.t, { llm })); }
    catch (e) { out.push({ t: rec.t, error: e.message }); }
  }
  return out;
}

module.exports = { getRegistry, saveRegistry, generate, check, checkAll, reset };
