import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectUpload, readApkManifest, BundleError } from './bundle.js';
import { openDb } from './db.js';
import { randomToken, sha256, hashAdminPassword, verifyAdminPassword, hashExitPassword, rateLimiter } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ONLINE_MS = 70_000;
const SESSION_MS = 12 * 3600_000;
const MESSAGE_TTL_MS = 7 * 24 * 3600_000;
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/png', test: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];
const BULK_COMMANDS = new Set(['message', 'reboot', 'sync', 'install', 'uninstall', 'exitKiosk', 'enterKiosk', 'decommission']);

const ACTION_LABEL = { message: 'mensaje', lock: 'bloqueo', unlock: 'desbloqueo', assignProfile: 'cambio de perfil', reboot: 'reinicio', sync: 'sincronización', install: 'instalar app', uninstall: 'desinstalar app', exitKiosk: 'salir del kiosko', enterKiosk: 'activar kiosko', decommission: 'baja' };

const DEFAULT_PROFILE = {
  title: 'WiFly', showClock: true, allowWifi: true, adbAllowed: false,
  wallpaperSha: '', launcherApkSha: '', apps: [], removePackages: [], helpers: [], exit: null,
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dataDir, adminUser = 'admin', adminPassword, secureCookies = false, trustProxy = false, longPollMs = 25_000, maxUploadMb = 1024 }) {
  const db = openDb(dataDir);
  const filesDir = path.join(dataDir, 'files');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  // ---- Datos iniciales ------------------------------------------------------------------
  let generatedPassword = null;
  if (!q('SELECT 1 FROM admins LIMIT 1').get()) {
    const pass = adminPassword || (generatedPassword = randomToken(12));
    const { salt, hash } = hashAdminPassword(pass);
    q('INSERT INTO admins (username, salt, hash) VALUES (?,?,?)').run(adminUser, salt, hash);
  }
  if (!q('SELECT 1 FROM profiles LIMIT 1').get()) {
    q('INSERT INTO profiles (name, json, updated_at) VALUES (?,?,?)').run('General', JSON.stringify(DEFAULT_PROFILE), now());
  }

  const audit = (actor, action, detail = '') => q('INSERT INTO audit (ts, actor, action, detail) VALUES (?,?,?,?)').run(now(), actor, action, String(detail).slice(0, 500));

  // ---- Long polling ---------------------------------------------------------------------
  const waiters = new Map();
  const wake = (deviceId) => {
    const w = waiters.get(deviceId);
    if (w) { waiters.delete(deviceId); w(); }
  };
  const wakeProfile = (profileId) => {
    for (const d of q('SELECT id FROM devices WHERE profile_id = ?').all(profileId)) wake(d.id);
  };

  // ---- Configuración efectiva de cada equipo ---------------------------------------------
  const fileBySha = (sha) => (sha ? q('SELECT * FROM files WHERE sha = ?').get(sha) : null);
  /** Para una app dividida incluye sus partes: el equipo elige las de su arquitectura y las instala juntas. */
  const apkRef = (sha) => {
    const f = fileBySha(sha);
    if (!f || f.kind !== 'apk') return null;
    const ref = { sha: f.sha, versionCode: f.version_code, size: f.size };
    if (f.parts) ref.parts = JSON.parse(f.parts);
    return ref;
  };

  function deviceConfig(device) {
    const row = device.profile_id ? q('SELECT json FROM profiles WHERE id = ?').get(device.profile_id) : null;
    const p = { ...DEFAULT_PROFILE, ...(row ? JSON.parse(row.json) : {}) };
    const over = JSON.parse(device.app_overrides);
    const removed = new Set(over.remove);
    const apps = p.apps.filter((a) => !removed.has(a.package));
    for (const pkg of over.add) if (!apps.some((a) => a.package === pkg)) apps.push({ package: pkg });
    const wp = fileBySha(p.wallpaperSha);
    const cfg = {
      title: p.title,
      showClock: p.showClock,
      allowWifi: p.allowWifi,
      adbAllowed: p.adbAllowed,
      wallpaper: wp ? { sha: wp.sha } : null,
      launcherApk: apkRef(p.launcherApkSha),
      apps: apps.map((a) => ({ package: a.package, label: a.label || '', apk: apkRef(a.apkSha) })),
      removePackages: p.removePackages,
      helpers: p.helpers,
      exit: p.exit,
      blocked: !!device.blocked,
      blockTitle: device.block_title,
      blockMessage: device.block_message,
    };
    return { ...cfg, version: sha256(JSON.stringify(cfg)).slice(0, 24) };
  }

  const expireOld = () => q(`UPDATE commands SET status='expired', updated_at=? WHERE status='pending' AND expires_at < ?`).run(now(), now());

  // ---- App --------------------------------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // ---- API de los equipos -----------------------------------------------------------------
  const enrollLimiter = rateLimiter({ max: 20, windowMs: 10 * 60_000 });

  app.post('/api/device/enroll', (req, res) => {
    if (enrollLimiter.blocked(req.ip)) throw new HttpError(429, 'Demasiados intentos');
    const { token, installId, model = '', manufacturer = '', androidVersion = '', sdk = 0 } = req.body || {};
    const t = typeof token === 'string' ? q('SELECT * FROM enroll_tokens WHERE token = ?').get(token) : null;
    const invalid = !t || (t.expires_at && t.expires_at < now()) || (t.max_uses && t.uses >= t.max_uses);
    if (invalid || typeof installId !== 'string' || installId.length < 8 || installId.length > 128) {
      enrollLimiter.hit(req.ip);
      throw new HttpError(403, 'Token de enrolamiento inválido o vencido');
    }
    const deviceToken = randomToken();
    const state = JSON.stringify({ model, manufacturer, androidVersion, sdk });
    const existing = q('SELECT id FROM devices WHERE install_id = ?').get(installId);
    let id;
    if (existing) {
      id = existing.id;
      q('UPDATE devices SET token_hash=?, state=?, last_seen=? WHERE id=?').run(sha256(deviceToken), state, now(), id);
    } else {
      id = crypto.randomUUID();
      const profile = t.profile_id || q('SELECT id FROM profiles ORDER BY id LIMIT 1').get()?.id || null;
      const name = `${String(model).slice(0, 40) || 'TV Box'} ${id.slice(0, 4)}`;
      q(`INSERT INTO devices (id, token_hash, install_id, name, grp, profile_id, state, last_seen, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`).run(id, sha256(deviceToken), installId, name, t.grp, profile, state, now(), now());
    }
    q('UPDATE enroll_tokens SET uses = uses + 1 WHERE token = ?').run(token);
    audit('equipo', 'alta', `${model} ${id.slice(0, 4)}`);
    res.json({ deviceId: id, deviceToken });
  });

  const deviceAuth = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const d = m ? q('SELECT * FROM devices WHERE token_hash = ?').get(sha256(m[1])) : null;
    if (!d) return res.status(401).json({ error: 'Equipo no registrado' });
    req.device = d;
    q('UPDATE devices SET last_seen=?, public_ip=? WHERE id=?').run(now(), req.ip || '', d.id);
    next();
  };

  app.get('/api/device/poll', deviceAuth, (req, res) => {
    const id = req.device.id;
    const respond = () => {
      const device = q('SELECT * FROM devices WHERE id = ?').get(id);
      if (!device) return res.status(401).json({ error: 'Equipo no registrado' });
      expireOld();
      const rows = q(`SELECT id, type, payload FROM commands WHERE device_id=? AND status='pending' ORDER BY created_at`).all(id);
      const mark = q(`UPDATE commands SET status='sent', updated_at=? WHERE id=?`);
      for (const c of rows) mark.run(now(), c.id);
      q('UPDATE devices SET last_seen=? WHERE id=?').run(now(), id);
      res.json({
        configVersion: deviceConfig(device).version,
        commands: rows.map((c) => ({ id: c.id, type: c.type, payload: JSON.parse(c.payload) })),
      });
    };
    const hasWork = q(`SELECT 1 FROM commands WHERE device_id=? AND status='pending' AND expires_at>=? LIMIT 1`).get(id, now());
    if (hasWork || deviceConfig(req.device).version !== req.query.cv) return respond();

    const previous = waiters.get(id);
    waiters.delete(id);
    if (previous) previous();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (waiters.get(id) === finish) waiters.delete(id);
      if (!res.writableEnded && !req.destroyed) respond();
    };
    const timer = setTimeout(finish, longPollMs);
    waiters.set(id, finish);
    req.on('close', () => {
      done = true;
      clearTimeout(timer);
      if (waiters.get(id) === finish) waiters.delete(id);
    });
  });

  app.get('/api/device/config', deviceAuth, (req, res) => res.json(deviceConfig(req.device)));

  app.post('/api/device/state', deviceAuth, (req, res) => {
    q('UPDATE devices SET state=? WHERE id=?').run(JSON.stringify(req.body || {}), req.device.id);
    res.json({ ok: true });
  });

  app.post('/api/device/commands/:id/result', deviceAuth, (req, res) => {
    const { ok, detail = '' } = req.body || {};
    q(`UPDATE commands SET status=?, detail=?, updated_at=? WHERE id=? AND device_id=?`)
      .run(ok ? 'done' : 'failed', String(detail).slice(0, 500), now(), req.params.id, req.device.id);
    res.json({ ok: true });
  });

  const sendStored = (res, sha) => {
    const f = /^[0-9a-f]{64}$/.test(sha) ? fileBySha(sha) : null;
    if (!f) throw new HttpError(404, 'Archivo inexistente');
    res.set('Content-Type', f.mime);
    res.sendFile(path.join(filesDir, f.sha));
  };
  app.get('/api/device/files/:sha', deviceAuth, (req, res) => sendStored(res, req.params.sha));

  // ---- Sesión del panel -------------------------------------------------------------------
  const loginLimiter = rateLimiter({ max: 8, windowMs: 15 * 60_000 });
  const COOKIE = 'wifly_session';
  const readCookie = (req) => {
    for (const part of (req.get('cookie') || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const setCookie = (res, value, maxAge) => res.append('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);

  app.post('/api/login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
    const { username, password } = req.body || {};
    const a = typeof username === 'string' ? q('SELECT * FROM admins WHERE username = ?').get(username) : null;
    const ok = a && typeof password === 'string' && verifyAdminPassword(password, a.salt, a.hash);
    if (!ok) {
      loginLimiter.hit(req.ip);
      throw new HttpError(401, 'Usuario o clave incorrectos');
    }
    loginLimiter.clear(req.ip);
    const token = randomToken();
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    q('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?,?,?)').run(sha256(token), a.id, now() + SESSION_MS);
    setCookie(res, token, SESSION_MS / 1000);
    audit(a.username, 'login');
    res.json({ username: a.username });
  });

  const adminAuth = (req, res, next) => {
    const token = readCookie(req);
    const s = token ? q(`SELECT a.id, a.username, a.salt, a.hash FROM sessions s JOIN admins a ON a.id = s.admin_id
                         WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) : null;
    if (!s) return res.status(401).json({ error: 'Sesión vencida' });
    // Un formulario de otro sitio no puede agregar este encabezado.
    if (req.method !== 'GET' && req.get('x-wifly') !== '1') return res.status(403).json({ error: 'Solicitud rechazada' });
    req.admin = s;
    next();
  };

  app.post('/api/logout', adminAuth, (req, res) => {
    q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(readCookie(req)));
    setCookie(res, '', 0);
    res.json({ ok: true });
  });
  app.get('/api/me', adminAuth, (req, res) => res.json({ username: req.admin.username }));
  app.post('/api/password', adminAuth, (req, res) => {
    const { current, next: nextPass } = req.body || {};
    if (typeof current !== 'string' || !verifyAdminPassword(current, req.admin.salt, req.admin.hash)) throw new HttpError(400, 'La clave actual no es correcta');
    if (typeof nextPass !== 'string' || nextPass.length < 10) throw new HttpError(400, 'La clave nueva necesita 10 caracteres o más');
    const { salt, hash } = hashAdminPassword(nextPass);
    q('UPDATE admins SET salt=?, hash=? WHERE id=?').run(salt, hash, req.admin.id);
    q('DELETE FROM sessions WHERE admin_id=? AND token_hash<>?').run(req.admin.id, sha256(readCookie(req)));
    audit(req.admin.username, 'cambio de clave');
    res.json({ ok: true });
  });

  // ---- Equipos ----------------------------------------------------------------------------
  const presentDevice = (d) => {
    const state = JSON.parse(d.state);
    const profile = d.profile_id ? q('SELECT name, json FROM profiles WHERE id=?').get(d.profile_id) : null;
    const pj = profile ? JSON.parse(profile.json) : {};
    const cfg = deviceConfig(d);
    return {
      id: d.id, name: d.name, group: d.grp, notes: d.notes, profileId: d.profile_id, profileName: profile?.name || '',
      blocked: !!d.blocked, blockTitle: d.block_title, blockMessage: d.block_message,
      overrides: JSON.parse(d.app_overrides), state, publicIp: d.public_ip, lastSeen: d.last_seen, createdAt: d.created_at,
      online: waiters.has(d.id) || now() - d.last_seen < ONLINE_MS,
      synced: state.appliedConfig === cfg.version,
      wallpaperSha: pj.wallpaperSha || '', title: pj.title || '', effectiveApps: cfg.apps.map((a) => a.package),
    };
  };

  app.get('/api/devices', adminAuth, (req, res) => {
    res.json(q('SELECT * FROM devices ORDER BY grp, name').all().map(presentDevice));
  });

  const getDevice = (id) => {
    const d = q('SELECT * FROM devices WHERE id=?').get(id);
    if (!d) throw new HttpError(404, 'Equipo inexistente');
    return d;
  };

  app.get('/api/devices/:id', adminAuth, (req, res) => {
    expireOld();
    const d = getDevice(req.params.id);
    const commands = q('SELECT type, payload, status, detail, created_at AS createdAt, updated_at AS updatedAt FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 30').all(d.id)
      .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));
    res.json({ ...presentDevice(d), commands });
  });

  app.patch('/api/devices/:id', adminAuth, (req, res) => {
    const d = getDevice(req.params.id);
    const b = req.body || {};
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : d.name;
    const grp = typeof b.group === 'string' ? b.group.trim().slice(0, 60) : d.grp;
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 500) : d.notes;
    let profileId = d.profile_id;
    if (b.profileId !== undefined) {
      if (b.profileId !== null && !q('SELECT 1 FROM profiles WHERE id=?').get(b.profileId)) throw new HttpError(400, 'Perfil inexistente');
      profileId = b.profileId;
    }
    let overrides = d.app_overrides;
    if (b.overrides) {
      const clean = (l) => (Array.isArray(l) ? l.filter(validPackage) : []);
      overrides = JSON.stringify({ add: clean(b.overrides.add), remove: clean(b.overrides.remove) });
    }
    q('UPDATE devices SET name=?, grp=?, notes=?, profile_id=?, app_overrides=? WHERE id=?').run(name, grp, notes, profileId, overrides, d.id);
    wake(d.id);
    res.json(presentDevice(getDevice(d.id)));
  });

  app.delete('/api/devices/:id', adminAuth, (req, res) => {
    const d = getDevice(req.params.id);
    q('DELETE FROM devices WHERE id=?').run(d.id);
    wake(d.id);
    audit(req.admin.username, 'equipo eliminado', d.name);
    res.json({ ok: true });
  });

  const validPackage = (p) => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(p);

  function validateCommand(action, payload) {
    if (action === 'message') {
      const title = String(payload.title || '').slice(0, 80);
      const body = String(payload.body || '').slice(0, 1000);
      if (!body.trim()) throw new HttpError(400, 'Escribí el texto del mensaje');
      const seconds = Math.max(0, Math.min(3600, Number(payload.seconds) || 0));
      return { title, body, seconds, mode: payload.mode === 'banner' ? 'banner' : 'modal' };
    }
    if (action === 'install') {
      const ref = apkRef(payload.sha);
      if (!ref) throw new HttpError(400, 'Elegí un APK de la biblioteca');
      return ref;
    }
    if (action === 'uninstall') {
      if (!validPackage(payload.package)) throw new HttpError(400, 'Paquete inválido');
      return { package: payload.package };
    }
    if (action === 'exitKiosk') return { relockOnBoot: !!payload.relockOnBoot };
    return {};
  }

  // Acciones sobre uno o varios equipos: el corazón del panel.
  app.post('/api/devices/bulk', adminAuth, (req, res) => {
    const { ids, action, payload = {} } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Seleccioná al menos un equipo');
    const devices = ids.map((id) => q('SELECT id, name FROM devices WHERE id=?').get(id)).filter(Boolean);
    if (!devices.length) throw new HttpError(404, 'Los equipos seleccionados ya no existen');
    const batch = crypto.randomUUID();

    if (action === 'lock' || action === 'unlock') {
      const blocked = action === 'lock' ? 1 : 0;
      const title = blocked ? String(payload.title || '').slice(0, 80) : '';
      const message = blocked ? String(payload.message || '').slice(0, 500) : '';
      for (const d of devices) {
        q('UPDATE devices SET blocked=?, block_title=?, block_message=? WHERE id=?').run(blocked, title, message, d.id);
        wake(d.id);
      }
    } else if (action === 'assignProfile') {
      if (!q('SELECT 1 FROM profiles WHERE id=?').get(payload.profileId)) throw new HttpError(400, 'Perfil inexistente');
      for (const d of devices) {
        q('UPDATE devices SET profile_id=? WHERE id=?').run(payload.profileId, d.id);
        wake(d.id);
      }
    } else if (BULK_COMMANDS.has(action)) {
      const clean = JSON.stringify(validateCommand(action, payload));
      for (const d of devices) {
        q(`INSERT INTO commands (id, device_id, batch_id, type, payload, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), d.id, batch, action, clean, now(), now(), now() + MESSAGE_TTL_MS);
        wake(d.id);
      }
    } else {
      throw new HttpError(400, 'Acción desconocida');
    }
    audit(req.admin.username, ACTION_LABEL[action] || action, `${devices.length} equipo(s): ${devices.map((d) => d.name).join(', ')}`);
    res.json({ ok: true, count: devices.length, batch });
  });

  app.get('/api/sends', adminAuth, (req, res) => {
    expireOld();
    const rows = q(`SELECT c.batch_id AS batch, c.type, c.payload, c.status, c.detail, c.created_at AS createdAt, d.name AS device
                    FROM commands c JOIN devices d ON d.id = c.device_id ORDER BY c.created_at DESC LIMIT 500`).all();
    const batches = new Map();
    for (const r of rows) {
      if (!batches.has(r.batch)) batches.set(r.batch, { batch: r.batch, type: r.type, payload: JSON.parse(r.payload), createdAt: r.createdAt, items: [] });
      batches.get(r.batch).items.push({ device: r.device, status: r.status, detail: r.detail });
    }
    res.json([...batches.values()]);
  });

  app.get('/api/audit', adminAuth, (req, res) => res.json(q('SELECT ts, actor, action, detail FROM audit ORDER BY id DESC LIMIT 200').all()));

  // Apps conocidas: lo que informan los equipos más la biblioteca. Alimenta el selector de perfiles.
  app.get('/api/known-apps', adminAuth, (req, res) => {
    const known = new Map();
    for (const d of q('SELECT state FROM devices').all()) {
      for (const a of JSON.parse(d.state).apps || []) {
        if (a.home) continue; // El launcher original nunca se ofrece como app permitida.
        if (!known.has(a.package)) known.set(a.package, { package: a.package, label: a.label, devices: 0 });
        known.get(a.package).devices++;
      }
    }
    for (const f of q(`SELECT * FROM files WHERE kind='apk'`).all()) {
      if (!known.has(f.package)) known.set(f.package, { package: f.package, label: f.name, devices: 0 });
    }
    res.json([...known.values()].sort((a, b) => a.label.localeCompare(b.label)));
  });

  // ---- Perfiles ---------------------------------------------------------------------------
  function cleanProfile(b, previous) {
    const list = (l) => (Array.isArray(l) ? [...new Set(l.filter(validPackage))] : []);
    const apps = (Array.isArray(b.apps) ? b.apps : []).filter((a) => a && validPackage(a.package)).map((a) => ({
      package: a.package, label: String(a.label || '').slice(0, 80), apkSha: apkRef(a.apkSha) ? a.apkSha : '',
    }));
    let exit = previous?.exit || null;
    const exitUser = String(b.exitUser ?? exit?.user ?? '').trim();
    if (b.exitPassword) {
      if (String(b.exitPassword).length < 8) throw new HttpError(400, 'La clave de salida necesita 8 caracteres o más');
      if (!exitUser) throw new HttpError(400, 'Indicá el usuario de salida');
      exit = hashExitPassword(exitUser.slice(0, 40), String(b.exitPassword));
    } else if (exit && exitUser && exitUser !== exit.user) {
      throw new HttpError(400, 'Para cambiar el usuario de salida, escribí también la clave');
    }
    return {
      title: String(b.title ?? 'WiFly').slice(0, 60),
      showClock: b.showClock !== false,
      allowWifi: b.allowWifi !== false,
      adbAllowed: b.adbAllowed === true,
      wallpaperSha: fileBySha(b.wallpaperSha)?.kind === 'image' ? b.wallpaperSha : '',
      launcherApkSha: apkRef(b.launcherApkSha) ? b.launcherApkSha : '',
      apps,
      removePackages: list(b.removePackages),
      helpers: list(b.helpers),
      exit,
    };
  }

  const presentProfile = (r) => {
    const p = JSON.parse(r.json);
    const { exit, ...rest } = p;
    return { id: r.id, name: r.name, updatedAt: r.updated_at, ...rest, exitUser: exit?.user || '', hasExit: !!exit,
      deviceCount: q('SELECT COUNT(*) AS n FROM devices WHERE profile_id=?').get(r.id).n };
  };

  const profileName = (b) => {
    const name = String(b?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Poné un nombre al perfil');
    return name;
  };

  app.get('/api/profiles', adminAuth, (req, res) => res.json(q('SELECT * FROM profiles ORDER BY name').all().map(presentProfile)));

  app.post('/api/profiles', adminAuth, (req, res) => {
    const name = profileName(req.body);
    if (q('SELECT 1 FROM profiles WHERE name=?').get(name)) throw new HttpError(409, 'Ya existe un perfil con ese nombre');
    const r = q('INSERT INTO profiles (name, json, updated_at) VALUES (?,?,?)').run(name, JSON.stringify(cleanProfile(req.body, null)), now());
    audit(req.admin.username, 'perfil creado', name);
    res.json(presentProfile(q('SELECT * FROM profiles WHERE id=?').get(r.lastInsertRowid)));
  });

  app.put('/api/profiles/:id', adminAuth, (req, res) => {
    const row = q('SELECT * FROM profiles WHERE id=?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Perfil inexistente');
    const name = profileName(req.body);
    const clash = q('SELECT id FROM profiles WHERE name=?').get(name);
    if (clash && clash.id !== row.id) throw new HttpError(409, 'Ya existe un perfil con ese nombre');
    q('UPDATE profiles SET name=?, json=?, updated_at=? WHERE id=?').run(name, JSON.stringify(cleanProfile(req.body, JSON.parse(row.json))), now(), row.id);
    wakeProfile(row.id);
    audit(req.admin.username, 'perfil guardado', name);
    res.json(presentProfile(q('SELECT * FROM profiles WHERE id=?').get(row.id)));
  });

  app.delete('/api/profiles/:id', adminAuth, (req, res) => {
    const row = q('SELECT * FROM profiles WHERE id=?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Perfil inexistente');
    if (q('SELECT COUNT(*) AS n FROM devices WHERE profile_id=?').get(row.id).n) throw new HttpError(409, 'Pasá los equipos a otro perfil antes de eliminar este');
    q('DELETE FROM profiles WHERE id=?').run(row.id);
    audit(req.admin.username, 'perfil eliminado', row.name);
    res.json({ ok: true });
  });

  // ---- Archivos ---------------------------------------------------------------------------
  const upload = multer({ dest: tmpDir, limits: { fileSize: maxUploadMb * 1024 * 1024 } });
  const presentFile = (f) => ({ sha: f.sha, kind: f.kind, name: f.name, size: f.size, package: f.package, versionCode: f.version_code, versionName: f.version_name, createdAt: f.created_at, parts: f.parts ? JSON.parse(f.parts).length : 0 });
  const labelOf = (m, fallback) => (typeof m.application?.label === 'string' && !m.application.label.startsWith('resourceId:') ? m.application.label : fallback);
  const insertFile = q(`INSERT OR REPLACE INTO files (sha, kind, name, size, mime, package, version_code, version_name, parts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const APK_MIME = 'application/vnd.android.package-archive';

  const hashFile = (p) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

  app.post('/api/files', adminAuth, upload.single('file'), async (req, res, next) => {
    const tmp = req.file?.path;
    try {
      if (!tmp) throw new HttpError(400, 'Elegí un archivo');
      const fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 120);
      const sha = await hashFile(tmp);
      let row;
      const image = IMAGE_MAGIC.find((m) => m.test(head));
      if (req.body.kind === 'image') {
        if (!image) throw new HttpError(400, 'La imagen tiene que ser JPG, PNG o WebP');
        row = { kind: 'image', mime: image.mime, name: original };
      } else if (req.body.kind === 'apk') {
        const found = await inspectUpload(tmp, tmpDir, maxUploadMb * 2 * 1024 * 1024);
        const fallback = original.replace(/\.(apk|apks|xapk|apkm)$/i, '');
        if (found.kind === 'split' && found.parts.length > 1) {
          // App dividida: cada parte se guarda por su SHA-256 y el registro de la app las enumera.
          const { base, parts } = found;
          for (const p of parts) {
            fs.renameSync(p.tmp, path.join(filesDir, p.sha));
            insertFile.run(p.sha, 'part', p.split || 'base', p.size, APK_MIME, p.package, p.versionCode, p.versionName, null, now());
          }
          fs.unlinkSync(tmp);
          const list = parts.map((p) => ({ sha: p.sha, split: p.split, size: p.size }));
          insertFile.run(sha, 'apk', labelOf(base.manifest, fallback), parts.reduce((n, p) => n + p.size, 0), APK_MIME, base.package, base.versionCode, base.versionName, JSON.stringify(list), now());
          audit(req.admin.username, 'archivo subido', `apk dividida ${base.package} (${parts.length} partes)`);
          return res.json({ ...presentFile(fileBySha(sha)), warning: found.warning });
        }
        let single = tmp, singleSha = sha, singleSize = req.file.size;
        if (found.kind === 'split') {
          // Un paquete con solo el APK base: se guarda como APK común.
          const p = found.parts[0];
          fs.unlinkSync(tmp);
          single = p.tmp; singleSha = p.sha; singleSize = p.size;
        }
        const m = await readApkManifest(single);
        if (m.split) throw new HttpError(400, 'Es una parte suelta de una app dividida. Subí el paquete completo (.apks, .xapk o .apkm).');
        fs.renameSync(single, path.join(filesDir, singleSha));
        insertFile.run(singleSha, 'apk', labelOf(m, fallback), singleSize, APK_MIME, m.package, m.versionCode || 0, String(m.versionName ?? ''), null, now());
        audit(req.admin.username, 'archivo subido', `apk ${m.package}`);
        return res.json({ ...presentFile(fileBySha(singleSha)), warning: found.warning || '' });
      } else {
        throw new HttpError(400, 'Tipo de archivo desconocido');
      }
      fs.renameSync(tmp, path.join(filesDir, sha));
      insertFile.run(sha, row.kind, row.name, req.file.size, row.mime, null, null, null, null, now());
      audit(req.admin.username, 'archivo subido', `${row.kind} ${row.name}`);
      res.json(presentFile(fileBySha(sha)));
    } catch (e) {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      next(e instanceof BundleError ? new HttpError(400, e.message) : e);
    }
  });

  app.get('/api/files', adminAuth, (req, res) => res.json(q(`SELECT * FROM files WHERE kind <> 'part' ORDER BY created_at DESC`).all().map(presentFile)));
  app.get('/api/files/:sha/content', adminAuth, (req, res) => sendStored(res, req.params.sha));

  app.delete('/api/files/:sha', adminAuth, (req, res) => {
    const f = fileBySha(req.params.sha);
    if (!f) throw new HttpError(404, 'Archivo inexistente');
    const used = q('SELECT name, json FROM profiles').all().find((p) => {
      const j = JSON.parse(p.json);
      return j.wallpaperSha === f.sha || j.launcherApkSha === f.sha || j.apps.some((a) => a.apkSha === f.sha);
    });
    if (used) throw new HttpError(409, `Lo usa el perfil ${used.name}`);
    q('DELETE FROM files WHERE sha=?').run(f.sha);
    fs.rmSync(path.join(filesDir, f.sha), { force: true });
    // Las partes se borran salvo que otra app dividida las comparta.
    const stillUsed = new Set(q('SELECT parts FROM files WHERE parts IS NOT NULL').all().flatMap((r) => JSON.parse(r.parts).map((p) => p.sha)));
    for (const p of f.parts ? JSON.parse(f.parts) : []) {
      if (stillUsed.has(p.sha)) continue;
      q(`DELETE FROM files WHERE sha=? AND kind='part'`).run(p.sha);
      fs.rmSync(path.join(filesDir, p.sha), { force: true });
    }
    res.json({ ok: true });
  });

  // ---- Tokens de alta -----------------------------------------------------------------------
  const presentToken = (t) => ({ token: t.token, label: t.label, profileId: t.profile_id, group: t.grp, uses: t.uses, maxUses: t.max_uses, expiresAt: t.expires_at, createdAt: t.created_at });
  app.get('/api/enroll-tokens', adminAuth, (req, res) => res.json(q('SELECT * FROM enroll_tokens ORDER BY created_at DESC').all().map(presentToken)));
  app.post('/api/enroll-tokens', adminAuth, (req, res) => {
    const b = req.body || {};
    const token = randomToken(12);
    const days = Math.max(0, Number(b.days) || 0);
    const profile = b.profileId && q('SELECT 1 FROM profiles WHERE id=?').get(b.profileId) ? b.profileId : null;
    q(`INSERT INTO enroll_tokens (token, label, profile_id, grp, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(token, String(b.label || '').slice(0, 80), profile, String(b.group || '').slice(0, 60), Math.max(0, Number(b.maxUses) || 0), days ? now() + days * 86400_000 : 0, now());
    audit(req.admin.username, 'token de alta creado', b.label || '');
    res.json(presentToken(q('SELECT * FROM enroll_tokens WHERE token=?').get(token)));
  });
  app.delete('/api/enroll-tokens/:token', adminAuth, (req, res) => {
    q('DELETE FROM enroll_tokens WHERE token=?').run(req.params.token);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta inexistente' }));
  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Archivo rechazado: ${err.message}` });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return { app, db, generatedPassword, close: () => db.close() };
}
