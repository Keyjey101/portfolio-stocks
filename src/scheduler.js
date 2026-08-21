// Фоновый прогрев расчётных кэшей (профиль «экономно», спек §3.2).
const DAY = 24 * 3600e3;
let started = false;
const timers = [];

function start() {
  if (started) return;
  started = true;
  const { runFactors } = require('./lab/factors');
  const warm = () => runFactors().catch(e => console.error('scheduler: factors:', e.message));
  timers.push(setTimeout(warm, 30e3));   // прогрев после старта
  timers.push(setInterval(warm, DAY));   // и далее раз в сутки
}

function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers.length = 0;
  started = false;
}

module.exports = { start, stop };
