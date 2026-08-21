// #5 калибровка уровней: GARCH-σ, вероятность касания, правила «фантазия/склеить/издержки».
// Чистая часть — calibrateLevels; заливка и кэш — runLevels ниже.
const { fitGARCH, garchForecast, pTouch } = require('../math/timeseries');

const DAY = 24 * 3600e3;

function calibrateLevels(closes, lv, horizonYr = 1) {
  const rets = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const fit = fitGARCH(rets);
  const { avgVar } = garchForecast(fit, 252);
  const sigAnn = Math.sqrt(252 * avgVar);
  // дрейф: историческая средняя × 0,5 (шринк к нулю — честный прокси, не прогноз)
  const muAnn = (rets.reduce((s, v) => s + v, 0) / rets.length) * 252 * 0.5;

  const px = closes.at(-1);
  const levels = lv
    .filter(v => v && v !== 999)
    .map(v => ({ v, p: pTouch(px, v, muAnn, sigAnn, horizonYr) }));

  // правила
  const t3 = lv[2], t1 = lv[0];
  const fantasy = !!(t3 && t3 !== 999 && pTouch(px, t3, muAnn, sigAnn, horizonYr) < 0.05);
  const sigUsd = sigAnn * px;
  const merge = [];
  for (let i = 0; i < levels.length; i++)
    for (let j = i + 1; j < levels.length; j++)
      if (Math.abs(levels[i].v - levels[j].v) < sigUsd) merge.push([levels[i].v, levels[j].v]);
  const l1 = levels.find(l => l.v === t1);
  const waitCost = l1 ? (1 - l1.p) * muAnn * horizonYr * px : null;

  return {
    px, sigAnn, muAnn, levels, fantasy, merge, waitCost,
    fit: { alpha: fit.alpha, beta: fit.beta },
  };
}

module.exports = { calibrateLevels };
