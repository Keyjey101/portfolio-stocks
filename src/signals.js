// Рыночные сигналы, вердикт и сборка данных (с кэшем 25 сек)

const { positions, posSource, watchlist, CASH, RULES } = require('./portfolio');
const { chart, sma, spark, pool, earningsDate } = require('./yahoo');
const { rulesCheck, overdueDays } = require('./rules');
const log = require('./log');

// '2026-08-06' → '06.08'
const fmtRu = d => typeof d === 'string' ? d.slice(8, 10) + '.' + d.slice(5, 7) : '';

// ── Сигналы ──
function vixSignal(v) {
  if (v == null) return { z:'—', mult:1, c:'d', txt:'нет данных' };
  if (v < 16)  return { z:'БЛАГОДУШИЕ', mult:1,   c:'y', txt:'базовый DCA, резерв не трогать' };
  if (v < 22)  return { z:'НОРМА',      mult:1,   c:'g', txt:'базовый DCA' };
  if (v < 30)  return { z:'СТРАХ',      mult:2,   c:'o', txt:'DCA ×2' };
  if (v < 40)  return { z:'ПАНИКА',     mult:3,   c:'r', txt:'DCA ×3 + транш из резерва' };
  return         { z:'КАПИТУЛЯЦИЯ',     mult:4,   c:'r', txt:'максимальный транш' };
}

function trendSignal(px, ma50, ma200, hi52) {
  if (px == null) return { z:'—', c:'d', txt:'нет данных', dd:null };
  const dd = hi52 ? (px / hi52 - 1) * 100 : 0;
  if (dd <= -15) return { z:'ПРОСАДКА 15%+', mult:3, c:'r', txt:'разворачивать резерв', dd };
  if (ma200 && px < ma200) return { z:'НИЖЕ 200MA', mult:2, c:'o', txt:'DCA ×2, включать уровни', dd };
  if (ma50 && px < ma50)   return { z:'НИЖЕ 50MA',  mult:1.5, c:'y', txt:'DCA ×1,5', dd };
  return { z:'ВЫШЕ 50MA', mult:1, c:'g', txt:'базовый DCA', dd };
}

function yieldSignal(closes) {
  // нет данных — отдельное состояние: оно НЕ должно засчитываться
  // как сработавший (зелёный) сигнал в вердикте
  if (!closes || closes.length < 21) return { z:'—', c:'d', txt:'нет данных', chg:0, ok:false };
  const now = closes.at(-1), then = closes.at(-21);
  const chg = (now - then) * 100; // б.п.
  if (chg >= 25)  return { z:'РОСТ СТАВОК', c:'r', txt:'сжатие мультипликаторов → половинные транши', chg, ok:true };
  if (chg <= -25) return { z:'СТАВКИ ВНИЗ', c:'g', txt:'★ давление снято — лучшее окно', chg, ok:true };
  return { z:'СТАБИЛЬНО', c:'y', txt:'нейтрально', chg, ok:true };
}

// какие из трёх сигналов сработали; «нет данных» никогда не срабатывает
function firesOf(sV, sT, sY) {
  return [
    sV.c === 'r' || sV.c === 'o',
    sT.c === 'r' || sT.c === 'o',
    sY.ok === true && sY.c === 'g',
  ];
}

// ── Статус позиции: смысл действия, а не один красный значок ──
// Приоритет: машина состояний тезиса (#М1) → st в META ('sell'|'broken'|'fix')
// → ★DCA → ⏸(until) → ✓Tn → ждать → ⚪
function statusOf(px, m = {}, now = new Date(), thesis = null) {
  const reviewDue = thesis?.review?.due || m.reviewBy || null;
  const od = reviewDue ? overdueDays(reviewDue, now) > 0 : false;
  const tipBits = [];
  if (thesis?.review?.reason) tipBits.push(thesis.review.reason);
  else if (m.check) tipBits.push(m.check);
  if (reviewDue) tipBits.push('пересмотр до ' + fmtRu(reviewDue));
  const tip = tipBits.join(' · ');
  // машина состояний тезиса первична (#М1)
  const st = thesis?.state || null;
  if (st === 'dead')      return { s:'⛔ ТЕЗИС МЁРТВ — выход', c:'r', tip };
  if (st === 'damaged')   return { s:'⛔ ТЕЗИС ПОВРЕЖДЁН', c:'r', od, tip };
  if (st === 'watch')     return { s:'⚠ НАБЛЮДЕНИЕ', c:'y', od, tip };
  if (st === 'recovering')return { s:'⏳ ВОССТАНОВЛЕНИЕ', c:'y', od, tip };
  if (m.st === 'sell')   return { s:'🔴 ПРОДАТЬ', c:'r', tip };
  // ⛔ + od: дата пересмотра прошла, а решения нет
  if (m.st === 'broken') return { s:'⛔ ТЕЗИС ПОВРЕЖДЁН', c:'r', od, tip };
  if (m.st === 'fix')    return { s:'🔵 ФИКС ЧАСТИ', c:'b', tip };
  // уровни из записи тезиса первичны (#М2), META — дефолт
  const thLv = thesis?.levels;
  const lv = thLv && [thLv.t1, thLv.t2, thLv.t3].some(v => v != null)
    ? [thLv.t1, thLv.t2, thLv.t3] : m.lv;
  const until = thLv?.until || m.until || null;
  if (!lv) {
    // открытый вопрос (держать/чистить) с датой решения — ⏸, не серое «не добирать»
    if (reviewDue) return { s:`⏸ ПЕРЕСМОТР до ${fmtRu(reviewDue)}`, c:'y', od, tip };
    return { s:'⚪ НЕ ДОБИРАТЬ', c:'d' };
  }
  const [t1, t2, t3] = lv;
  if (t1 === 999) return { s:'★ ЕЖЕМЕСЯЧНО', c:'g' };
  // достигнутый уровень (1|2|3) — до вывода зелёного
  const tier = t3 && px <= t3 ? 3 : t2 && px <= t2 ? 2 : t1 && px <= t1 ? 1 : 0;
  // ⏸ уровень достигнут, но подтверждения нет (обязательно для conditional,
  // т.е. damaged/recovering — активация парой «цена + факт», не одной ценой)
  if (tier && until) return { s:`⏸ T${tier} ✓ — ждёт ${until.event}`, c:'y', tip: [until.check, tip].filter(Boolean).join(' · ') };
  if (tier === 3) return { s:`✓✓✓ T3 ≤${t3}`, c:'g' };
  if (tier === 2) return { s:`✓✓ T2 ≤${t2}`, c:'g' };
  if (tier === 1) return { s:`✓ T1 ≤${t1}`, c:'g' };
  const next = t1 || t2 || t3;
  return next ? { s:`ждать ${next} (${((next/px-1)*100).toFixed(0)}%)`, c:'d' } : { s:'⚪ НЕ ДОБИРАТЬ', c:'d' };
}

// ── Статус вотчлиста: уровни кандидата ──
// В отличие от позиций, пробой зоны СНИЗУ — не «покупай ещё дешевле»,
// а повод перепроверить тезис: зону ставили по другому состоянию бумаги
function watchStatus(px, lv) {
  if (!lv || px == null) return { s:'—', c:'d' };
  const [t1, t2, t3] = lv;
  const lowest = t3 || t2 || t1;
  // лёгкий прокол под уровень — шум, уровень достигнут;
  // глубокий (>5% под зоной) — зона устарела, тезис перепроверить
  if (lowest && px < lowest * 0.95) return { s:'⏷ ниже зоны — пересмотреть', c:'y' };
  if (t3 && px <= t3) return { s:`✓✓✓ T3 ≤${t3}`, c:'g' };
  if (t2 && px <= t2) return { s:`✓✓ T2 ≤${t2}`, c:'g' };
  if (t1 && px <= t1) return { s:`✓ T1 ≤${t1}`, c:'g' };
  const next = t1 || t2 || t3;
  return next ? { s:`ждать ${next} (${((next/px-1)*100).toFixed(0)}%)`, c:'d' } : { s:'—', c:'d' };
}

// ── Сборка данных ──
async function build() {
  const [vix, spx, tnx] = await Promise.all([
    chart('^VIX').catch(() => null),
    chart('^GSPC').catch(() => null),
    chart('^TNX').catch(() => null),
  ]);

  const vixV = vix?.price ?? null;
  const spxPx = spx?.price ?? null;
  const ma50 = spx ? sma(spx.closes, 50) : null;
  const ma200 = spx ? sma(spx.closes, 200) : null;
  let tnxCloses = tnx?.closes ?? [];
  if (tnxCloses.length && tnxCloses.at(-1) > 20) tnxCloses = tnxCloses.map(v => v / 10);
  const y10 = tnxCloses.at(-1) ?? null;

  const sV = vixSignal(vixV);
  const sT = trendSignal(spxPx, ma50, ma200, spx?.hi52);
  const sY = yieldSignal(tnxCloses);

  const [fV, fT, fY] = firesOf(sV, sT, sY);
  const green = [fV, fT, fY].filter(Boolean).length;
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const dd = sT.dd || 0;
  // близость к срабатыванию: 0 — далеко, 1 — порог достигнут
  const progT = Math.max(
    clamp01(-dd / 15),
    ma200 && spxPx ? clamp01(1 + (1 - spxPx / ma200) / 0.05) : 0
  );
  const verdict = green >= 2
    ? { t:'ОКНО ОТКРЫТО — разворачивать резерв', c:'g' }
    : green === 1
    ? { t:'ЧАСТИЧНОЕ ОКНО — половинный транш', c:'y' }
    : { t:'ОКНА НЕТ — только базовый DCA', c:'r' };
  verdict.n = green;
  verdict.fires = [
    { name:'Страх · VIX', fires:fV,
      now: vixV == null ? 'нет данных' : 'VIX ' + vixV.toFixed(1),
      need:'сработает при VIX ≥ 22 (СТРАХ+) → DCA ×2–×4',
      prog: vixV == null ? 0 : clamp01((vixV - 15) / 7) },
    { name:'Просадка · S&P', fires:fT,
      now: 'от пика ' + dd.toFixed(1) + '%' + (ma200 && spxPx ? ' · ' + ((spxPx / ma200 - 1) * 100).toFixed(1) + '% над 200MA' : ''),
      need:'сработает ниже 200MA или при −15% от пика',
      prog: progT },
    { name:'Ставки · 10Y', fires:fY,
      now: (sY.chg || 0) === 0 && !tnxCloses.length ? 'нет данных' : (sY.chg >= 0 ? '+' : '') + sY.chg.toFixed(0) + ' б.п. за месяц',
      need:'сработает при ≤ −25 б.п. за месяц',
      prog: clamp01(-(sY.chg || 0) / 25) },
  ];

  const list = await positions();
  const thesesAll = require('./lab/theses').listAll();
  const rows = await pool(list.filter(p => p.qty > 0 || p.t === 'ITOT'), async p => {
    try {
      const d = await chart(p.t, '3mo');
      const px = d.price;
      const val = px * p.qty;
      const pnl = p.avg > 0 ? (px / p.avg - 1) * 100 : null;
      const day = d.prevClose ? (px / d.prevClose - 1) * 100 : null;
      const thesis = thesesAll[p.t] || null;
      return { ...p, px, val, pnl, day, thesis, lvl: statusOf(px, p, new Date(), thesis), ok: true, sp: spark(d.closes) };
    } catch (e) {
      return { ...p, ok: false, err: e.message };
    }
  });

  const watch = await pool(watchlist(), async w => {
    try {
      const d = await chart(w.t, '3mo');
      const px = d.price;
      return { ...w, px, day: d.prevClose ? (px / d.prevClose - 1) * 100 : null, lvl: watchStatus(px, w.lv), ok:true, sp: spark(d.closes) };
    } catch (e) { log.warn(`watch ${w.t} не загрузился`, e); return { ...w, lvl: watchStatus(null, w.lv), ok:false }; }
  });

  const total = rows.filter(r => r.ok).reduce((s, r) => s + r.val, 0);
  const byTag = {};
  rows.filter(r => r.ok).forEach(r => { byTag[r.tag] = (byTag[r.tag] || 0) + r.val; });

  return {
    generatedAt: new Date().toISOString(),
    posSource: posSource(),
    vixV, spxPx, ma50, ma200, y10, sV, sT, sY, verdict,
    rows, watch, total, byTag, cash: CASH,
    rules: rulesCheck(rows, total, CASH, RULES),
    spxSpark: spark(spx?.closes ?? [], 120),
    vixSpark: spark(vix?.closes ?? [], 60),
    tnxSpark: spark(tnxCloses, 60),
  };
}

// ── Публичный (гостевой) режим: доллары вырезаются, проценты остаются ──
// Санитизация на сервере, а не на фронте: гость не должен уметь достать
// qty/avg/val из ответа даже через F12. byTag превращается в доли (%).
function sanitizeForGuest(D) {
  const total = D.total > 0 ? D.total : 0;
  const pct = v => (total > 0 ? (v / total) * 100 : null);
  const rules = D.rules && {
    ai: D.rules.ai && { ...D.rules.ai, val: null, excess: null },
    cash: D.rules.cash && { ...D.rules.cash, short: null },
    max: D.rules.max && { ...D.rules.max, pct: D.rules.max.pct }, // pct — доля, не деньги
    broken: D.rules.broken && { ...D.rules.broken, val: null },
  };
  return {
    ...D,
    guest: true,
    total: null,
    cash: null,
    cashPct: D.total + D.cash > 0 ? D.cash / (D.total + D.cash) * 100 : null,
    byTag: Object.fromEntries(Object.entries(D.byTag || {}).map(([k, v]) => [k, pct(v)])),
    rows: (D.rows || []).map(r => ({ ...r, qty: null, avg: null, val: null })),
    rules,
  };
}

// ── Календарь отчётов на 30 дней: позиции + вотчлист, кэш 6 ч ──
const CAL_TTL = 6 * 3600e3;
const calCache = { ts: 0, data: null, promise: null };

async function getCalendar() {
  if (calCache.data && Date.now() - calCache.ts < CAL_TTL) return calCache.data;
  if (calCache.promise) return calCache.promise;
  calCache.promise = (async () => {
    const list = await positions().catch(() => []);
    const symbols = [...new Set([...list.map(p => p.t), ...watchlist().map(w => w.t)])]
      .filter(t => /^[A-Z][A-Z0-9.-]*$/.test(t)); // только обыкновенные тикеры
    const items = [];
    await pool(symbols, async t => {
      const e = await earningsDate(t).catch(() => null);
      if (e) items.push({ t, ts: e.ts, days: e.days });
    }, 6);
    items.sort((a, b) => a.ts - b.ts);
    return { ok: true, generatedAt: new Date().toISOString(), items };
  })()
    .then(data => { calCache.data = data; calCache.ts = Date.now(); return data; })
    .catch(e => ({ ok: false, error: String(e.message || e), items: [] }))
    .finally(() => { calCache.promise = null; });
  return calCache.promise;
}
// ── Раздача данных: живые → память → диск, и запрос никогда не виснет ──
// Раньше: пока build() ждал зависшие fetch к Yahoo (нет таймаутов), ВСЕ
// /api/data ждали тот же promise — страница застревала на загрузке.
// Теперь: сборка идёт в фоне; запрос отдаёт свежее из памяти сразу, при
// холодном старте ждёт максимум DATA_DEADLINE, затем — последняя успешная
// сборка с диска. Деградировавшая сборка (рынок недоступен) не затирает
// хорошую в памяти и не пишется на диск.
const DATA_TTL = 25000;      // свежесть в памяти, как раньше
const DATA_DEADLINE = 15000; // максимум ожидания HTTP-запросом
const cache = { ts: 0, data: null, building: null, err: null };
const { readCache, writeCache } = require('./cache');

const isGoodData = d => d && d.spxPx != null && d.vixV != null
  && (d.rows || []).filter(r => r.ok).length >= 3;

function getData() {
  if (!cache.building && !(cache.data && Date.now() - cache.ts < DATA_TTL)) {
    cache.err = null;
    cache.building = build()
      .then(d => {
        if (!cache.data || isGoodData(d)) {
          cache.ts = Date.now();
          cache.data = d;
          if (isGoodData(d)) writeCache('data', d);
        }
      })
      .catch(e => { cache.err = e; })
      .finally(() => { cache.building = null; });
  }
  // stale-while-revalidate: есть что отдать — отдаём, пересборка идёт фоном
  if (cache.data) return Promise.resolve(cache.data);
  // холодный старт: ждём сборку недолго, дальше — диск, иначе честная ошибка
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cache.data) { clearInterval(iv); resolve(cache.data); return; }
      if (Date.now() - t0 > DATA_DEADLINE) {
        clearInterval(iv);
        const stale = readCache('data');
        if (stale) resolve(stale);
        else reject(new Error('рынок недоступен (' + (cache.err ? cache.err.message : 'Yahoo не отвечает') + ') — повтори через минуту'));
      }
    }, 250);
  });
}

module.exports = { getData, getCalendar, vixSignal, trendSignal, yieldSignal, firesOf, watchStatus, statusOf, sanitizeForGuest };
