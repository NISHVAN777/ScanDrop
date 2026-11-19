import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------- Server secret (signs temporary download tokens) ----------

export function loadOrCreateSecret(file) {
  try {
    const s = fs.readFileSync(file);
    if (s.length >= 32) return s;
  } catch { /* first run */ }
  const secret = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// ---------- PINs ----------

export const isValidPin = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

/** Slow, salted hash so a stolen database doesn't reveal PINs easily. */
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32);
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

export function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || !stored) return false;
  const [salt, hash] = stored.split('.');
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(pin, Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- Random tokens ----------

/** Secret given once to the uploader; only its hash is stored. */
export const newOwnerToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/**
 * Short-lived signed tokens proving the PIN was entered for a file.
 * Format: "<expiresAtMs>.<hmac>" - no server-side state needed.
 */
export function createAccessTokens(secret, ttlMs) {
  const sign = (id, exp) =>
    crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  return {
    issue(id) {
      const exp = Date.now() + ttlMs;
      return `${exp}.${sign(id, exp)}`;
    },
    verify(id, token) {
      if (typeof token !== 'string') return false;
      const [expStr, mac] = token.split('.');
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false;
      return safeEqual(mac, sign(id, exp));
    },
  };
}

// ---------- Rate limiting ----------

/**
 * Simple in-memory fixed-window limiter per client IP.
 * Fine for one server; use Redis or similar if you run several.
 */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, reset }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.reset <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(req.ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Please wait a bit and try again.' });
    }
    next();
  };
}
