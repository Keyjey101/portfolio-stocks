// Фоновый прогрев расчётных кэшей (профиль «экономно», спек §3.2):
// факторы/уровни/детектор — ежедневно, Монте-Карло и комитет — еженедельно,
// проверка фальсификаций — ежеквартально (cooldown внутри checkAll).
const DAY = 24 * 3600e3;
const WEEK = 7 * DAY;
let started = false;
const timers = [];

function start() {
  if (started) return;
  started = true;
  const { runFactors } = require('./lab/factors');
  const { runLevels } = require('./lab/levels');
  const { runMC } = require('./lab/mc');
  const { runDetector } = require('./lab/detector');
  const committee = require('./lab/committee');
  const falsify = require('./lab/falsify');
  const warmDaily = () => {
    runFactors().catch(e => console.error('scheduler: factors:', e.message));
    runLevels().catch(e => console.error('scheduler: levels:', e.message));
    runDetector().catch(e => console.error('scheduler: detector:', e.message));
  };
  const warmWeekly = () => {
    runMC().catch(e => console.error('scheduler: mc:', e.message));
    committee.scoreMatured().catch(e => console.error('scheduler: score:', e.message));
    committee.runCommittee().catch(e => console.error('scheduler: committee:', e.message));
  };
  const warmQuarterly = () => falsify.checkAll().catch(e => console.error('scheduler: falsify:', e.message));
  timers.push(setTimeout(warmDaily, 30e3));
  timers.push(setInterval(warmDaily, DAY));
  timers.push(setTimeout(warmWeekly, 90e3));
  timers.push(setInterval(warmWeekly, WEEK));
  timers.push(setInterval(warmQuarterly, 89 * DAY));
}

function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers.length = 0;
  started = false;
}

module.exports = { start, stop };
