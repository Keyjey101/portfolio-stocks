// Дисковый кэш data/cache/<name>.json с TTL. Атомарная запись: tmp + rename.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'cache');
const fileOf = name => path.join(DIR, `${name}.json`);

function writeCache(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = fileOf(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), data }));
  fs.renameSync(tmp, fileOf(name));
}

function readCache(name, ttlMs) {
  let j;
  try { j = JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); } catch { return null; }
  if (!j || !j.savedAt) return null;
  if (ttlMs != null && Date.now() - Date.parse(j.savedAt) >= ttlMs) return null;
  return j.data;
}

function cacheAgeMs(name) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
    return j && j.savedAt ? Date.now() - Date.parse(j.savedAt) : null;
  } catch { return null; }
}

module.exports = { readCache, writeCache, cacheAgeMs };
