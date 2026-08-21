// Позиции напрямую из Tradernet API (freedom24.com) — без файла-посредника.
// Авторизация как в официальном Python-SDK (tradernet/core.py):
//   POST https://freedom24.com/api/<cmd>
//   тело: компактный JSON параметров
//   X-NtApi-PublicKey / X-NtApi-Timestamp / X-NtApi-Sig = HMAC-SHA256(priv, тело+ts)
// Ключи читаются кодом из .env: TRADERNET_PUBLIC_KEY / TRADERNET_PRIVATE_KEY.
//
// Сеть: freedom24.com может быть недоступен напрямую. Порядок попыток:
//   1) TRADERNET_PROXY из .env (если задан — всегда только он);
//   2) найденный ранее локальный прокси (data/proxy.json, проверяется);
//   3) прямое соединение (работает, когда VPN в режиме TUN);
//   4) при сбое — автопоиск локального прокси: сканируются слушающие порты
//      127.0.0.1 (netstat), каждый пробуется как HTTP-CONNECT и SOCKS5.
// Работающий прокси запоминается. Если ничего не нашли — позиции отдаются
// из кэша (data/positions.json), источник помечается.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { execFile } = require('child_process');
const { loadEnv } = require('./env');

const DOMAIN = 'freedom24.com';
const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const POS_CACHE_FILE = path.join(ROOT, 'data', 'positions.json');
const PROXY_CACHE_FILE = path.join(ROOT, 'data', 'proxy.json');
const TTL_MS = 60 * 1000;        // свежесть списка позиций
const DIRECT_TIMEOUT_MS = 8000;  // прямой fetch (сайт может молча висеть)
const PROBE_TIMEOUT_MS = 1200;   // проверка одного порта при сканировании
const RESCAN_AFTER_MS = 5 * 60 * 1000; // пауза между автопоиском

const ENV = loadEnv(ENV_FILE);
const PUBLIC_KEY = ENV.TRADERNET_PUBLIC_KEY || '';
const PRIVATE_KEY = ENV.TRADERNET_PRIVATE_KEY || '';
const ENV_PROXY = (ENV.TRADERNET_PROXY || '').trim();

// ── туннели: HTTP CONNECT и SOCKS5 ──
function httpTunnel(proxyHost, proxyPort, host, port, timeoutMs, auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
      const headers = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (auth) headers.push(`Proxy-Authorization: Basic ${auth}`);
      headers.push('', '');
      socket.write(headers.join('\r\n'));
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { socket.destroy(); reject(new Error('tunnel: timeout')); });
    socket.once('error', reject);
    let handshake = '';
    function onData(chunk) {
      handshake += chunk.toString('latin1');
      if (!handshake.includes('\r\n\r\n')) {
        if (handshake.length > 8192) { socket.destroy(); reject(new Error('tunnel: большой handshake')); }
        return;
      }
      socket.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(handshake)) {
        socket.destroy();
        reject(new Error('tunnel: CONNECT отклонён'));
        return;
      }
      resolve(socket);
    }
    socket.on('data', onData);
  });
}

function socks5Tunnel(proxyHost, proxyPort, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fail = (msg) => { socket.destroy(); reject(new Error('socks5: ' + msg)); };
    const socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // no-auth
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail('timeout'));
    socket.once('error', e => reject(e));
    let stage = 1;
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('нужна авторизация/отказ');
        buf = buf.subarray(2);
        stage = 2;
        const domain = Buffer.from(host, 'utf8');
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
          domain,
          Buffer.from([port >> 8, port & 0xff]),
        ]));
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        if (buf[1] !== 0x00) return fail('соединение отклонено');
        const atyp = buf[3];
        let need = 4; // hdr(4) без адреса
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x03) need += 1 + buf[4] + 2;
        else if (atyp === 0x04) need += 16 + 2;
        else return fail('неизвестный atyp');
        if (buf.length < need) return;
        socket.setTimeout(0);
        resolve(socket);
      }
    });
  });
}

// ── HTTP/1.1 поверх TLS-туннеля ──
function parseHttp11(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error('пустой ответ');
  const head = raw.slice(0, idx).toString('latin1');
  const status = +((head.split('\r\n')[0] || '').split(' ')[1] || 0);
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  }
  let body = raw.slice(idx + 4);
  if ((headers['transfer-encoding'] || '').includes('chunked')) {
    const parts = [];
    let pos = 0;
    while (pos < body.length) {
      const eol = body.indexOf('\r\n', pos);
      if (eol < 0) break;
      const size = parseInt(body.slice(pos, eol).toString('latin1').split(';')[0], 16);
      if (!size) break;
      parts.push(body.slice(eol + 2, eol + 2 + size));
      pos = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status, body };
}

async function requestViaProxy(proxyUrlStr, urlStr, { method, headers, body, timeoutMs = 15000 }) {
  const target = new URL(urlStr);
  const proxy = new URL(proxyUrlStr);
  const scheme = (proxy.protocol.replace(':', '') || 'http').toLowerCase();
  const port = target.port || 443;
  const auth = proxy.username
    ? Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64')
    : null;

  let socket;
  if (scheme.startsWith('socks')) {
    socket = await socks5Tunnel(proxy.hostname, +proxy.port || 1080, target.hostname, port, timeoutMs, auth);
  } else {
    socket = await httpTunnel(proxy.hostname, +proxy.port || 8080, target.hostname, port, timeoutMs, auth);
  }

  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: target.hostname }, () => {
      const reqHeaders = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .concat('Connection: close', `Content-Length: ${Buffer.byteLength(body || '')}`);
      secure.write(
        `${method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
        `Host: ${target.hostname}\r\n${reqHeaders.join('\r\n')}\r\n\r\n` +
        (body || '')
      );
    });
    let raw = Buffer.alloc(0);
    secure.on('data', c => { raw = Buffer.concat([raw, c]); });
    secure.on('end', () => {
      try { resolve(parseHttp11(raw)); } catch (e) { reject(e); }
    });
    secure.on('error', reject);
    secure.setTimeout(timeoutMs, () => { secure.destroy(); reject(new Error('tls: таймаут')); });
  });
}

// ── автопоиск локального прокси ──
function listLocalPorts() {
  return new Promise(resolve => {
    execFile('netstat', ['-ano'], { windowsHide: true }, (err, stdout) => {
      const ports = new Set();
      if (err) return resolve([]);
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTEN/i.test(line)) continue;
        const m = line.trim().match(/^(?:TCP)\s+(\S+?):(\d+)\s+/);
        if (!m) continue;
        if (!['127.0.0.1', '0.0.0.0', '::1', '[::]'].includes(m[1])) continue;
        const port = +m[2];
        if (port > 0 && port < 65536) ports.add(port);
      }
      resolve([...ports].sort((a, b) => a - b));
    });
  });
}

async function probeProxy(urlStr, host = DOMAIN, port = 443, timeoutMs = PROBE_TIMEOUT_MS) {
  const proxy = new URL(urlStr);
  const scheme = (proxy.protocol.replace(':', '') || 'http').toLowerCase();
  const socket = scheme.startsWith('socks')
    ? await socks5Tunnel(proxy.hostname, +proxy.port || 1080, host, port, timeoutMs)
    : await httpTunnel(proxy.hostname, +proxy.port || 8080, host, port, timeoutMs);
  socket.destroy();
  return true;
}

let detectedProxy = null;   // 'http://127.0.0.1:7890' | null
let lastScanTs = 0;
let scanning = null;

function loadPersistedProxy() {
  try {
    const saved = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8'));
    if (saved && typeof saved.url === 'string' && Date.now() - Date.parse(saved.foundAt) < 7 * 864e5) {
      return saved.url;
    }
  } catch { /* нет файла — ок */ }
  return null;
}

function persistProxy(url) {
  try {
    fs.mkdirSync(path.dirname(PROXY_CACHE_FILE), { recursive: true });
    fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({ url, foundAt: new Date().toISOString() }));
  } catch { /* не критично */ }
}

async function detectProxy() {
  if (ENV_PROXY) return ENV_PROXY; // явная настройка важнее всего
  if (detectedProxy) return detectedProxy;
  if (Date.now() - lastScanTs < RESCAN_AFTER_MS) return null;
  if (scanning) return scanning;

  lastScanTs = Date.now();
  scanning = (async () => {
    // 1) сохранённый — проверить живость
    const saved = loadPersistedProxy();
    if (saved) {
      try { await probeProxy(saved); detectedProxy = saved; return saved; }
      catch { /* устарел — ищем заново */ }
    }

    // 2) скан всех слушающих портов 127.0.0.1
    const ports = await listLocalPorts();
    const candidates = [];
    for (const p of ports) {
      candidates.push(`http://127.0.0.1:${p}`, `socks5://127.0.0.1:${p}`);
    }
    for (const url of candidates) {
      try {
        await probeProxy(url);
        detectedProxy = url;
        persistProxy(url);
        console.log(`Tradernet: найден локальный прокси ${url}`);
        return url;
      } catch { /* не прокси — следующий */ }
    }
    return null;
  })().finally(() => { scanning = null; });

  return scanning;
}

// ── запрос к API: прокси → прямой → (при сбое) автопоиск и повтор ──
async function rawRequest(cmd, { method, headers, body }) {
  const proxy = await detectProxy();
  if (proxy) {
    const res = await requestViaProxy(proxy, `https://${DOMAIN}/api/${cmd}`, {
      method, headers, body, timeoutMs: 15000,
    });
    return { status: res.status, text: res.body.toString('utf8') };
  }
  const res = await fetch(`https://${DOMAIN}/api/${cmd}`, {
    method, headers, body,
    signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

async function api(cmd, params = {}) {
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    throw new Error('Нет ключей Tradernet в .env (TRADERNET_PUBLIC_KEY / TRADERNET_PRIVATE_KEY)');
  }
  const body = JSON.stringify(params);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', PRIVATE_KEY).update(body + ts).digest('hex');
  const headers = {
    'Content-Type': 'application/json',
    'X-NtApi-PublicKey': PUBLIC_KEY,
    'X-NtApi-Timestamp': ts,
    'X-NtApi-Sig': sig,
  };

  let out;
  try {
    out = await rawRequest(cmd, { method: 'POST', headers, body });
  } catch (e) {
    // прямой коннект не прошёл — возможно, включился системный прокси: ищем
    detectedProxy = null;
    lastScanTs = 0;
    const proxy = await detectProxy();
    if (!proxy) throw new Error(`нет маршрута до ${DOMAIN} (включи VPN: TUN или системный прокси)`);
    const res = await requestViaProxy(proxy, `https://${DOMAIN}/api/${cmd}`, {
      method: 'POST', headers, body, timeoutMs: 15000,
    });
    out = { status: res.status, text: res.body.toString('utf8') };
  }

  if (out.status < 200 || out.status >= 300) throw new Error(`Tradernet ${cmd}: HTTP ${out.status}`);
  const data = JSON.parse(out.text);
  if (data && data.errMsg) throw new Error(`Tradernet ${cmd}: ${data.errMsg}`);
  return data;
}

// ── разбор ответа (имена полей у API плавают — берём варианты) ──
// Актуальный формат (2026-08): pos[] с короткими полями
//   i="ACIW.US", q=11, bal_price_a=39.62, price_a=39.62, open_bal=435.83
const TICKER_KEYS = ['instr_name', 'ticker', 'symbol', 'nt_ticker', 'instr', 'i', 'base_contract_code'];
const QTY_KEYS = ['sum_qty', 'qty', 'quantity', 'full_qty', 'sum_quantity', 'q'];
const AVG_KEYS = [
  'avg_open_price', 'avg_open', 'open_price', 'avg_price',
  'open_avg_price', 'avg_buy_price', 'avg',
  'bal_price_a', 'price_a', 'bal_price',
];
const SUM_OPEN_KEYS = ['sum_open_price', 'sum_open', 'open_sum_price', 'open_bal'];

function num(item, keys) {
  for (const k of keys) {
    const v = item[k];
    if (v == null || v === '') continue;
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

function tickerOf(item) {
  for (const k of TICKER_KEYS) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function looksLikePosition(x) {
  return x && typeof x === 'object' && !Array.isArray(x)
    && tickerOf(x) !== null && num(x, QTY_KEYS) !== null;
}

// ищет самый длинный «массив позиций» в произвольной структуре ответа
function extractPositions(node) {
  let best = [];
  (function walk(n) {
    if (Array.isArray(n)) {
      const items = n.filter(looksLikePosition);
      if (items.length && items.length >= n.length / 2 && items.length > best.length) best = items;
      n.forEach(walk);
    } else if (n && typeof n === 'object') {
      Object.values(n).forEach(walk);
    }
  })(node);
  return best;
}

// → [{ t: 'ACIW', qty: 11, avg: 39.62 }] (ACIW.US → ACIW)
function normalize(items) {
  const out = [];
  for (const item of items) {
    const raw = tickerOf(item);
    const qty = num(item, QTY_KEYS);
    let avg = num(item, AVG_KEYS);
    if (avg == null && qty) {
      const sumOpen = num(item, SUM_OPEN_KEYS);
      if (sumOpen != null) avg = Math.abs(sumOpen / qty);
    }
    if (!raw || !qty || !avg) continue;
    const t = raw.replace(/\.[A-Z]{1,3}$/, '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]*$/.test(t)) continue;
    out.push({ t, qty: Math.round(Math.abs(qty)), avg });
  }
  return out;
}

// ── кэш позиций: память → диск; TTL 60 сек; при сбое — последний успешный ──
const cache = { ts: 0, list: null, promise: null };
let source = 'cache';

try {
  const saved = JSON.parse(fs.readFileSync(POS_CACHE_FILE, 'utf8'));
  if (Array.isArray(saved.list) && saved.list.length) cache.list = saved.list;
} catch { /* нет файла — ок */ }

function saveDiskCache(list) {
  try {
    fs.mkdirSync(path.dirname(POS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(POS_CACHE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), list }));
  } catch (e) {
    console.error('positions.json: не сохранён:', e.message);
  }
}

async function getPositions() {
  if (cache.list && Date.now() - cache.ts < TTL_MS) return cache.list;
  if (cache.promise) return cache.promise;

  cache.promise = api('getPositionJson')
    .then(data => {
      const list = normalize(extractPositions(data));
      if (!list.length) throw new Error('Tradernet: позиции не распознаны в ответе API');
      cache.ts = Date.now();
      cache.list = list;
      source = 'api';
      saveDiskCache(list);
      return list;
    })
    .finally(() => { cache.promise = null; });

  try {
    return await cache.promise;
  } catch (e) {
    console.error('Tradernet API недоступен:', e.message);
    if (cache.list) { source = 'cache'; return cache.list; }
    throw new Error('Tradernet API недоступен и нет кэша позиций: ' + e.message);
  }
}

// откуда взят последний отданный список: 'api' | 'cache'
function posSource() {
  return source;
}

module.exports = { getPositions, posSource, extractPositions, normalize, requestViaProxy, probeProxy };
