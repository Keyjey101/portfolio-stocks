// #3 реестр фальсификаций (Поппер для портфеля): при покупке LLM генерирует
// 3 фальсифицируемых условия «тезис мёртв, если…»; агент проверяет их
// ежеквартально по отчётам и новостям. Триггер → позиция помечается.
const fs = require('fs');
const path = require('path');
const { META } = require('../portfolio');
const { fetchHeadlines } = require('../news');
const { edgarRecent } = require('../edgar');
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
};

const CHECK_SCHEMA = { verdicts: 'array' };

// сгенерировать/перегенерировать фальсификации для тикера
async function generate(t, { llm = defaultLlm } = {}) {
  const T = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(T)) throw new Error('введи тикер латиницей, например TSM');
  const meta = META[T] || {};
  const [news, filings] = await Promise.all([
    fetchHeadlines(T).catch(() => []),
    edgarRecent(T).catch(() => []),
  ]);
  const prompt = [
    `Тикер: ${T}. Бакет портфеля: ${meta.tag || '—'}. Заметка владельца: «${meta.note || '—'}».`,
    `Уровни докупа: ${JSON.stringify(meta.lv || null)}.`,
    news.length ? 'Контекст новостей:' + news.slice(0, 6).map(n => '\n- ' + n.title).join('') : '',
    filings.length ? 'Филлинги: ' + filings.slice(0, 4).map(f => `${f.form} от ${f.date}`).join(', ') : '',
    '',
    'Сформулируй тезис владельца одним предложением и ровно ТРИ условия фальсификации:',
    'каждое — конкретное, измеримое по публичным данным (отчёты/новости), без оценочных слов;',
    'наступление любого условия означает, что тезис мёртв, и позицию надо закрывать или пересматривать.',
    'Верни ТОЛЬКО JSON: {"thesis":"…","conditions":[{"text":"…"},{"text":"…"},{"text":"…"}]}',
  ].filter(Boolean).join('\n');

  const v = await llm.chat(
    [{ role: 'system', content: 'Ты аналитик, применяющий принцип фальсифицируемости Поппера к инвесттезисам. Отвечай только JSON.' },
     { role: 'user', content: prompt }],
    { schema: GEN_SCHEMA, task: 'falsify-generate', t: T, temperature: 0.3 },
  );

  const conds = (v.conditions || [])
    .map(c => (typeof c === 'string' ? { text: c } : c))
    .filter(c => c.text && String(c.text).length > 8)
    .slice(0, 3);
  if (conds.length < 3) throw new Error(`${T}: сгенерировано ${conds.length} условий вместо 3`);

  const reg = getRegistry().filter(r => r.t !== T);
  const rec = {
    t: T, thesis: v.thesis, conditions: conds,
    createdAt: new Date().toISOString(), status: 'active',
    checks: [],
  };
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

  const [news, filings] = await Promise.all([
    fetchHeadlines(T).catch(() => []),
    edgarRecent(T).catch(() => []),
  ]);
  const prompt = [
    `Тикер: ${T}. Тезис: «${rec.thesis}».`,
    'Условия фальсификации:',
    ...rec.conditions.map((c, i) => `${i}. ${c.text}`),
    news.length ? 'Заголовки (последние):' + news.slice(0, 10).map(n => '\n- ' + n.title).join('') : 'Новостей нет.',
    filings.length ? 'Филлинги: ' + filings.slice(0, 5).map(f => `${f.form} от ${f.date}: ${f.url}`).join('\n') : 'Филлингов нет.',
    '',
    'По каждому условию вынеси вердикт на основе ПРИВЕДЁННЫХ данных (не выдумывай факты):',
    'triggered=true только если есть прямое свидетельство; иначе false с кратким evidence (что известно).',
    'Верни ТОЛЬКО JSON: {"verdicts":[{"i":0,"triggered":false,"evidence":"…"},…]} — по всем условиям.',
  ].join('\n');

  const v = await llm.chat(
    [{ role: 'system', content: 'Ты аудитор инвесттезисов. Работаешь строго по предоставленным данным, не галлюцинируешь факты. Отвечай только JSON.' },
     { role: 'user', content: prompt }],
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
  reg[idx] = rec;
  saveRegistry(reg);
  return rec;
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

module.exports = { getRegistry, saveRegistry, generate, check, checkAll };
