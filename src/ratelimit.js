// Простейший per-key лимитер частоты (fixed window, в памяти).
// Ключ — обычно IP-суффикс вида "1.2.3.4:w" (write) / ":r" (read).

function createLimiter({ now = () => Date.now() } = {}) {
  const hits = new Map(); // key → { n, resetAt }

  return function allow(key, limit, windowMs) {
    const t = now();
    let h = hits.get(key);
    if (!h || t >= h.resetAt) { h = { n: 0, resetAt: t + windowMs }; hits.set(key, h); }
    h.n++;
    if (h.n > limit) return false;
    // уборка, чтобы Map не рос без границы под сканом адресов
    if (hits.size > 4096) for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
    return true;
  };
}

module.exports = { createLimiter };
