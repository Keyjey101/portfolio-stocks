// Оверрайды мета-позиций от LLM-агентов (falsify): data/overrides.json.
// Хардкод в portfolio.js остаётся дефолтом; при работе с тикером в /lab
// агент может обновить только поля whitelist: lv / until / note.
// tag, st, reviewBy, check — книжные правила и статусы, агенту недоступны.
const fs = require('fs');
const path = require('path');

// путь можно переопределить (OVERRIDES_FILE) — тесты гоняют файлы параллельно
const FILE = () => process.env.OVERRIDES_FILE || path.join(__dirname, '..', 'data', 'overrides.json');
const FIELDS = ['lv', 'until', 'note'];

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

function write(o) {
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, f);
}

// уровни докупа/входа: ровно 3 элемента, число|null; числа в 5–110% текущей
// цены (докуп обычно ниже цены, watch-зона может быть чуть выше; null = не докупать).
// px неизвестен — без границ.
function validLv(lv, px) {
  if (!Array.isArray(lv) || lv.length !== 3) return null;
  const out = lv.map(v => (v == null ? null : +v));
  const ok = out.every(v => v == null
    || (Number.isFinite(v) && (!px || (v >= 0.05 * px && v <= 1.10 * px))));
  return ok && out.some(v => v != null) ? out : null;
}

// ждущее событие: короткая строка + чем проверить; пустое событие = нет
function validUntil(event, check) {
  if (typeof event !== 'string' || event.trim().length < 4) return null;
  return { event: event.trim().slice(0, 120), check: String(check || '').trim().slice(0, 160) };
}

// сливает оверрайд с дефолтом (оверрайд выигрывает), только whitelist-поля
function applyTo(def, ov) {
  if (!ov) return def;
  const o = {};
  for (const k of FIELDS) if (ov[k] != null) o[k] = ov[k];
  return { ...def, ...o };
}

// эффективная мета тикера: дефолт + оверрайд
function merged(t, def) {
  return applyTo(def, read()[t]);
}

// записать патч (только whitelist + снимок «было»); провенанс _at/_src
function set(t, patch, source) {
  const allOv = read();
  const next = { ...(allOv[t] || {}) };
  for (const k of FIELDS) if (patch[k] != null) next[k] = patch[k];
  if (patch._was) next._was = patch._was;
  next._at = new Date().toISOString();
  next._src = source || 'llm';
  allOv[t] = next;
  write(allOv);
  return next;
}

// вернуть дефолт: удалить запись
function clear(t) {
  const allOv = read();
  if (!(t in allOv)) return false;
  delete allOv[t];
  write(allOv);
  return true;
}

const get = t => read()[t] || null;
const all = () => read();

module.exports = { merged, set, clear, get, all, validLv, validUntil, applyTo, FIELDS };
