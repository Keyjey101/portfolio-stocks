// Рыночные сигналы, вердикт и сборка данных (с кэшем 25 сек)

const { positions, posSource, WATCH, CASH } = require('./portfolio');
const { chart, sma, spark, pool } = require('./yahoo');

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
// st в META: 'sell' (продать) | 'broken' (тезис повреждён) | 'fix' (фикс части)
// Приоритет: sell → broken → fix → ★DCA → ⏸(until, B2) → ✓Tn → ждать → ⚪
function statusOf(px, m = {}) {
  if (m.st === 'sell')   return { s:'🔴 ПРОДАТЬ', c:'r' };
  if (m.st === 'broken') return { s:'⛔ ТЕЗИС ПОВРЕЖДЁН', c:'r' };
  if (m.st === 'fix')    return { s:'🔵 ФИКС ЧАСТИ', c:'b' };
  const lv = m.lv;
  if (!lv) return { s:'⚪ НЕ ДОБИРАТЬ', c:'d' };
  const [t1, t2, t3] = lv;
  if (t1 === 999) return { s:'★ ЕЖЕМЕСЯЧНО', c:'g' };
  if (t3 && px <= t3) return { s:`✓✓✓ T3 ≤${t3}`, c:'g' };
  if (t2 && px <= t2) return { s:`✓✓ T2 ≤${t2}`, c:'g' };
  if (t1 && px <= t1) return { s:`✓ T1 ≤${t1}`, c:'g' };
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
  const rows = await pool(list.filter(p => p.qty > 0 || p.t === 'ITOT'), async p => {
    try {
      const d = await chart(p.t, '3mo');
      const px = d.price;
      const val = px * p.qty;
      const pnl = p.avg > 0 ? (px / p.avg - 1) * 100 : null;
      const day = d.prevClose ? (px / d.prevClose - 1) * 100 : null;
      return { ...p, px, val, pnl, day, lvl: statusOf(px, p), ok: true, sp: spark(d.closes) };
    } catch (e) {
      return { ...p, ok: false, err: e.message };
    }
  });

  const watch = await pool(WATCH, async w => {
    try {
      const d = await chart(w.t, '3mo');
      const px = d.price;
      return { ...w, px, day: d.prevClose ? (px / d.prevClose - 1) * 100 : null, lvl: watchStatus(px, w.lv), ok:true, sp: spark(d.closes) };
    } catch { return { ...w, lvl: watchStatus(null, w.lv), ok:false }; }
  });

  const total = rows.filter(r => r.ok).reduce((s, r) => s + r.val, 0);
  const byTag = {};
  rows.filter(r => r.ok).forEach(r => { byTag[r.tag] = (byTag[r.tag] || 0) + r.val; });

  return {
    generatedAt: new Date().toISOString(),
    posSource: posSource(),
    vixV, spxPx, ma50, ma200, y10, sV, sT, sY, verdict,
    rows, watch, total, byTag, cash: CASH,
    spxSpark: spark(spx?.closes ?? [], 120),
    vixSpark: spark(vix?.closes ?? [], 60),
    tnxSpark: spark(tnxCloses, 60),
  };
}

// ── Кэш данных (25 сек), единый fetch на параллельных клиентов ──
const cache = { ts: 0, data: null, promise: null };
function getData() {
  if (cache.data && Date.now() - cache.ts < 25000) return Promise.resolve(cache.data);
  if (cache.promise) return cache.promise;
  cache.promise = build()
    .then(d => { cache.ts = Date.now(); cache.data = d; cache.promise = null; return d; })
    .catch(e => { cache.promise = null; throw e; });
  return cache.promise;
}

module.exports = { getData, vixSignal, trendSignal, yieldSignal, firesOf, watchStatus, statusOf };
