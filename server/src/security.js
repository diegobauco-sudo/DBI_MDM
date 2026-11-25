import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashAdminPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

export function verifyAdminPassword(password, salt, hash) {
  const got = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

/** Credenciales de salida del kiosko. Mismo algoritmo que Crypto.java en el launcher. */
export function hashExitPassword(user, password, iter = 60000) {
  const salt = crypto.randomBytes(16);
  return { user, salt: salt.toString('hex'), iter, hash: crypto.pbkdf2Sync(password, salt, iter, 32, 'sha256').toString('hex') };
}

/** Limitador en memoria por clave (IP). */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return {
    blocked(key) {
      const v = hits.get(key);
      return !!v && v.until > Date.now() && v.count >= max;
    },
    hit(key) {
      const now = Date.now();
      const v = hits.get(key);
      if (!v || v.until < now) hits.set(key, { count: 1, until: now + windowMs });
      else v.count++;
    },
    clear(key) { hits.delete(key); },
  };
}
