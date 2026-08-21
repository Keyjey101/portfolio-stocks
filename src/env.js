// Чтение .env (KEY=VALUE) — без зависимостей. Комментарии и пустые строки пропускаются.
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnv(file = ENV_FILE) {
  const env = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return env; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

module.exports = { loadEnv };
