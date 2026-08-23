// Двухуровневый доступ: гость (без пароля) / владелец (cookie-токен).
// Пароль — APP_PASSWORD из process.env или .env. Если пароль не задан,
// авторизация выключена и все считаются владельцем (локальная работа).
// Токен: "<exp_ms>.<hmac_sha256(exp, secret)>" — сессий без БД: смена пароля
// мгновенно инвалидирует все выданные токены (secret производен от пароля).

const crypto = require('crypto');
const { loadEnv } = require('./env');

const COOKIE = 'pt_auth';
const TTL_MS = 30 * 86400e3;          // 30 дней
const ATTEMPTS = 8, ATTEMPT_WIN = 5 * 60e3;

function conf() {
  return process.env.APP_PASSWORD || loadEnv().APP_PASSWORD || '';
}

function enabled() {
  return !!conf();
}

// секрет выводим из пароля: проверка токена не требует хранения пароля в памяти роутера
const secretOf = pw => crypto.createHash('sha256').update('portfolio-terminal/v1:' + pw).digest();

function signToken(ttlMs = TTL_MS, now = Date.now()) {
  const exp = now + ttlMs;
  const sig = crypto.createHmac('sha256', secretOf(conf())).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i <= 0) return false;
  const exp = Number(token.slice(0, i));
  const sig = token.slice(i + 1);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const want = crypto.createHmac('sha256', secretOf(conf())).update(String(exp)).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const k = pair.indexOf('=');
    if (k > 0) out[pair.slice(0, k).trim()] = decodeURIComponent(pair.slice(k + 1).trim());
  }
  return out;
}

function isOwner(req) {
  if (!enabled()) return true;
  return verifyToken(parseCookies(req)[COOKIE]);
}

function setAuthCookie(res, token, ttlMs = TTL_MS, secure = false) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
}

function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── лимит попыток подбора: per-IP, окно ATTEMPT_WIN ──
const attempts = new Map(); // ip → { n, resetAt }

function attemptAllowed(ip, now = Date.now()) {
  let a = attempts.get(ip);
  if (!a || now >= a.resetAt) { a = { n: 0, resetAt: now + ATTEMPT_WIN }; attempts.set(ip, a); }
  return a.n < ATTEMPTS;
}

function noteAttempt(ip) {
  let a = attempts.get(ip);
  if (a) a.n++;
}

function clearAttempts(ip) { attempts.delete(ip); }

// Проверка пароля + выдача cookie. false — неверный пароль или лимит попыток.
function login(ip, password, res, { secure = false, now = Date.now() } = {}) {
  if (!enabled()) return true; // пароля нет — «вход» не нужен, все и так владельцы
  if (!attemptAllowed(ip, now)) return false;
  const want = Buffer.from(conf());
  const got = Buffer.from(String(password ?? ''));
  const ok = want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!ok) { noteAttempt(ip); return false; }
  clearAttempts(ip);
  setAuthCookie(res, signToken(TTL_MS, now), TTL_MS, secure);
  return true;
}

module.exports = { enabled, isOwner, login, logout, signToken, verifyToken, parseCookies, COOKIE, TTL_MS };
