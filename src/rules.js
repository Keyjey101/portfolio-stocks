// Правила портфеля: AI-потолок, кэш, макс. имя, повреждённые тезисы.
// Чистая функция над строками книги — считается машиной, а не глазами по донату.

// сколько дней назад наступила дата пересмотра (0 — ещё не пора / не задана)
function overdueDays(reviewBy, now = new Date()) {
  if (!reviewBy || typeof reviewBy !== 'string') return 0;
  const t = Date.parse(reviewBy + 'T00:00:00');
  if (Number.isNaN(t)) return 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - t) / 864e5));
}

function rulesCheck(rows, total, cash, rules, now = new Date()) {
  const ok = rows.filter(r => r.ok);
  const sumBy = pred => ok.filter(pred).reduce((s, r) => s + r.val, 0);

  // 1. AI-ядро против потолка; скрытая бета (доля индексов × коэффициент) — отдельной строкой
  const core = sumBy(r => r.tag === 'core');
  const indexVal = sumBy(r => r.tag === 'index');
  const aiPct = total > 0 ? core / total : 0;
  const hiddenPct = total > 0 ? (core + indexVal * rules.hiddenAiFactor) / total : 0;

  // 2. Кэш: цель — доля от стоимости позиций; недобор в долларах
  const cashTarget = total * rules.cashTargetPct;
  const cashShare = total + cash > 0 ? cash / (total + cash) : 0;

  // 3. Макс. имя против потолка
  const maxRow = ok.reduce((a, r) => (r.val > (a ? a.val : -1) ? r : a), null);

  // 4. Повреждённые тезисы (+ кто просрочил пересмотр)
  const brokenVal = sumBy(r => r.st === 'broken');
  const brokenOverdue = ok
    .filter(r => r.st === 'broken' && overdueDays(r.reviewBy, now) > 0)
    .map(r => r.t);

  return {
    ai: {
      pct: aiPct, val: core, hiddenPct, target: rules.aiCeiling,
      excess: core - rules.aiCeiling * total,
      c: aiPct > rules.aiCeiling + 1e-9 ? 'r' : 'g',
    },
    cash: {
      pct: cashShare, target: rules.cashTargetPct,
      short: Math.max(0, cashTarget - cash),
      c: cashTarget > cash + 1e-9 ? 'o' : 'g',
    },
    max: {
      t: maxRow ? maxRow.t : null, target: rules.maxNamePct,
      pct: maxRow && total > 0 ? maxRow.val / total : 0,
      c: maxRow && total > 0 && maxRow.val / total > rules.maxNamePct + 1e-9 ? 'r' : 'g',
    },
    broken: {
      pct: total > 0 ? brokenVal / total : 0, val: brokenVal, overdue: brokenOverdue,
      c: brokenVal > 0 ? 'o' : 'g',
    },
  };
}

module.exports = { rulesCheck, overdueDays };
