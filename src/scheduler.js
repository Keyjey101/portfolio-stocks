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
  // setTimeout ограничен 2^31-1 мс (~24,8 дня) — длинные каденции клипуются
  // (месячная фактически сработает через ~24,8 дня — приемлемый дрейф)
  const delay = Math.min(ms, 2147483647);
  const run = () => {
    const h = setTimeout(() => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
      Promise.resolve(fn()).catch(() => {}).finally(run);
    }, delay);
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
  const theses = require('./lab/theses');
  const { runDueChains } = require('./lab/calendar');
  const { runDerive, needsRederive } = require('./lab/derivation');
  const { readCache } = require('./cache');
  const warmDaily = () => {
    runFactors().catch(e => console.error('scheduler: factors:', e.message));
    runLevels().catch(e => console.error('scheduler: levels:', e.message));
    runDetector().catch(e => console.error('scheduler: detector:', e.message));
    // #М3: T+1 после отчёта — переоценка тезиса → переход → перевывод уровней
    runDueChains({ calendarLoader: () => require('./signals').getCalendar() })
      .then(r => { if (r.ran) console.log(`scheduler: earnings chain обработала ${r.ran} отчёт(ов)`); })
      .catch(e => console.error('scheduler: earnings chain:', e.message));
    // #М8: дневной снапшот NAV → TWR; #М2: перевывод при уходе цены >25%
    Promise.resolve()
      .then(() => {
        const D = readCache('data', 2 * DAY);
        if (D?.total > 0) require('./lab/journal').appendNav(D.total);
        const pxOf = Object.fromEntries((D?.rows || []).filter(r => r.ok).map(r => [r.t, r.px]));
        for (const rec of Object.values(theses.listAll())) {
          if (!rec.levels?.px_at) continue;
          const px = pxOf[rec.t];
          if (px && needsRederive(rec, px)) {
            runDerive(rec.t, { trigger: 'price±25%' })
              .catch(e => console.error(`scheduler: rederive ${rec.t}:`, e.message));
          }
        }
      })
      .catch(() => {});
  };
  const warmWeekly = () => {
    runMC().catch(e => console.error('scheduler: mc:', e.message));
    committee.scoreMatured().catch(e => console.error('scheduler: score:', e.message));
    committee.runCommittee().catch(e => console.error('scheduler: committee:', e.message));
  };
  const warmQuarterly = () => falsify.checkAll().catch(e => console.error('scheduler: falsify:', e.message));

  // #6 журнал: автодетект сделок (дифф снапшота позиций) каждые 15 мин
  const snapshotCheck = () => {
    const fs = require('fs');
    const path = require('path');
    const SNAP = path.join(__dirname, '..', 'data', 'journal-snapshot.json');
    const { getPositions } = require('./tradernet');
    const journal = require('./lab/journal');
    getPositions()
      .then(list => {
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(SNAP, 'utf8')).list; } catch {}
        if (prev) journal.pendingTrades(journal.detectTrades(prev, list));
        fs.mkdirSync(path.dirname(SNAP), { recursive: true });
        fs.writeFileSync(SNAP, JSON.stringify({ ts: new Date().toISOString(), list }));
      })
      .catch(() => {});
  };

  // #6/#М8 контрфактуалы (30/90/365 + ITOT), точность советов и уровней,
  // TWR портфеля: еженедельно, кэш 6 ч
  const weeklyJournal = () => {
    const journal = require('./lab/journal');
    const { chart } = require('./yahoo');
    const { WATCH } = require('./portfolio');
    const { writeCache } = require('./cache');
    const priceLoader = async (t, tradingDaysAgo) => {
      const d = await chart(t, tradingDaysAgo > 200 ? '3y' : '1y').catch(() => null);
      if (!d || !d.closes.length) return null;
      const i = d.closes.length - 1 - tradingDaysAgo;
      return i >= 0 ? d.closes[i] : d.closes[0];
    };
    const seriesLoader = async t => {
      const d = await chart(t, '1y').catch(() => null);
      return d?.closes || null;
    };
    const decisions = journal.listDecisions();
    Promise.all([
      journal.computeCounterfactuals({ decisions, priceLoader, watch: WATCH.map(w => w.t) }),
      journal.adviceAccuracy({ priceLoader }),
      journal.levelsAccuracy({ seriesLoader }).catch(() => null),
      // TWR портфеля против ITOT за период наблюдения NAV
      (async () => {
        const nav = journal.listNav();
        if (nav.length < 2) return null;
        const flows = journal.navFlowsFromDecisions(decisions);
        const port = journal.twr(nav, flows);
        const d = await chart('ITOT', '2y').catch(() => null);
        if (!d?.closes?.length || !d?.ts?.length) return { portfolio: port, itot: null };
        const from = nav[0].date, to = nav.at(-1).date;
        const itotNav = d.ts
          .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), total: d.closes[i] }))
          .filter(p => p.date >= from && p.date <= to);
        return { portfolio: port, itot: journal.twr(itotNav, []) };
      })().catch(() => null),
    ])
      .then(([items, advice, levels, twrData]) => writeCache('counterfactuals', { items, advice, levels, twr: twrData, at: new Date().toISOString() }))
      .catch(e => console.error('scheduler: counterfactuals:', e.message));
  };

  // #8 капцикл: композит ежемесячно, капекс качается внутри (кэш EDGAR 6ч→89д агенты)
  const monthlyCapcycle = () => require('./lab/capcycle').runCapcycle().catch(e => console.error('scheduler: capcycle:', e.message));

  setTimeout(warmDaily, 30e3);
  every(DAY, warmDaily);
  setTimeout(warmWeekly, 90e3);
  every(WEEK, warmWeekly);
  every(QUARTER, warmQuarterly);
  setTimeout(snapshotCheck, 60e3);
  every(15 * 60e3, snapshotCheck);
  every(WEEK, weeklyJournal);
  every(30 * DAY, monthlyCapcycle);
}

function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers.length = 0;
  started = false;
}

module.exports = { start, stop };
