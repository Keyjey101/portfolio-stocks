'use strict';
// Журнальный логгер: всё в stderr → systemd/journald (ротация на стороне
// системы), приложение файлов не создаёт. Дедуп: повтор той же беды молчит
// 10 минут, потом однострочный повтор со счётчиком — «что упало и где»
// видно, а журнал не тонет в спаме каждые 90 секунд автообновления.

const TTL_MS = 10 * 60e3;
const seen = new Map();

function emit(level, ctx, err) {
  const e = err instanceof Error ? err : (err != null ? new Error(String(err)) : null);
  const msg = e ? e.message : '';
  const key = ctx + ' :: ' + msg;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev.ts < TTL_MS) { prev.count++; return false; }
  const repeat = prev ? ` (повтор ×${prev.count + 1})` : '';
  seen.set(key, { ts: now, count: 0 });
  // место падения: первый пользовательский фрейм стека (файл:строка)
  let where = '';
  if (e && e.stack) {
    const line = e.stack.split('\n')
      .filter(l => l.trim().startsWith('at ') && !l.includes('node:'))
      [0];
    if (line) where = ' · ' + line.trim().slice(3);
  }
  console.error(`[${level}] ${ctx}: ${msg || '(без сообщения)'}${where}${repeat}`);
  return true;
}

module.exports = {
  err: (ctx, e) => emit('err', ctx, e),
  warn: (ctx, e) => emit('warn', ctx, e),
};
