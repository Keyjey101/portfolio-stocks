// Макро-фон из FRED (Сент-Луис): ставки, спред, инфляция, безработица.
// Ключ FRED_API_KEY в .env (не обязателен — без него /api/macro отвечает ok:false,
// фронт просто прячет полосу). Кэш 12 ч: эти ряды обновляются раз в день/месяц.

const { readCache, writeCache } = require('./cache');
const { loadEnv } = require('./env');
const log = require('./log');

const TTL = 12 * 3600e3;

// yoy: сравниваем последнее наблюдение с ~год назад (limit 14 месяцев ≈ 13 назад)
const SERIES = [
  { id: 'DGS10',    name: '10Y',        limit: 2 },
  { id: 'DGS2',     name: '2Y',         limit: 2 },
  { id: 'T10Y2Y',   name: 'Спред 10Y−2Y', limit: 2 },
  { id: 'UNRATE',   name: 'Безработица', limit: 2 },
  { id: 'CPIAUCSL', name: 'CPI г/г',    limit: 14, yoy: true },
];

const keyOf = () => process.env.FRED_API_KEY || loadEnv().FRED_API_KEY || '';

async function fetchSeries(s, key, { fetchImpl = fetch } = {}) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}` +
    `&api_key=${key}&file_type=json&sort_order=desc&limit=${s.limit}`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`FRED ${s.id}: HTTP ${r.status}`);
  const j = await r.json();
  const obs = (j.observations || []).filter(o => o.value !== '.').map(o => ({ date: o.date, v: parseFloat(o.value) }));
  if (!obs.length) throw new Error(`FRED ${s.id}: нет наблюдений`);
  const last = obs[0], prev = obs[1] || obs[0];
  const yearAgo = obs[13] || obs[obs.length - 1];
  const value = s.yoy ? (last.v / yearAgo.v - 1) * 100 : last.v;
  const prevValue = s.yoy ? (prev.v / (obs[14] || yearAgo).v - 1) * 100 : prev.v;
  return { id: s.id, name: s.name, value, prev: prevValue, date: last.date, unit: s.yoy ? '%' : '%' };
}

async function getMacro({ fetchImpl = fetch, force = false } = {}) {
  const key = keyOf();
  if (!key) return { ok: false, reason: 'нет FRED_API_KEY' };
  if (!force) {
    const c = readCache('macro', TTL);
    if (c) return { ok: true, ...c, cached: true };
  }
  const items = [];
  for (const s of SERIES) {
    // один сбой ряда не должен ронять всю полосу
    try { items.push(await fetchSeries(s, key, { fetchImpl })); }
    catch (e) { log.warn(`fred ряд ${s.id} пропущен`, e); }
  }
  if (!items.length) throw new Error('FRED: ни один ряд не загрузился');
  const data = { generatedAt: new Date().toISOString(), items };
  writeCache('macro', data);
  return { ok: true, ...data };
}

module.exports = { getMacro, SERIES };
