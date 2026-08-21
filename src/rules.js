// Правила портфеля: AI-потолок, кэш, макс. имя, повреждённые тезисы.
// Чистая функция над строками книги — считается машиной, а не глазами по донату.

function rulesCheck(rows, total, cash, rules) {
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

  // 4. Повреждённые тезисы
  const brokenVal = sumBy(r => r.st === 'broken');

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
      pct: total > 0 ? brokenVal / total : 0, val: brokenVal,
      c: brokenVal > 0 ? 'o' : 'g',
    },
  };
}

module.exports = { rulesCheck };
