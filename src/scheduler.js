// Фоновый прогрев расчётных кэшей (профиль «экономно», спек §3.2):
// факторы/уровни/детектор — ежедневно, Монте-Карло и комитет — еженедельно,
// проверка фальсификаций — ежеквартально (cooldown внутри checkAll).
// ВАЖНО: setInterval ограничен 2^31-1 мс (~24,8 дня) — длинные каденции
// chains-ом setTimeout, иначе Node молча превращает интервал в 1 мс (баг шторма).
const DAY = 24 * 3600e3;
const WEEK = 7 * DAY;
const QUARTER = 89 * DAY;
let started = false;
const timers = [];

function every(ms, fn) {
  const run = () => {
    const h = setTimeout(() => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
      Promise.resolve(fn()).catch(() => {}).finally(run);
    }, ms);
    timers.push(h);
  };
  run();
}

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

  setTimeout(warmDaily, 30e3);
  every(DAY, warmDaily);
  setTimeout(warmWeekly, 90e3);
  every(WEEK, warmWeekly);
  every(QUARTER, warmQuarterly);
}

function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers.length = 0;
  started = false;
}

module.exports = { start, stop };
