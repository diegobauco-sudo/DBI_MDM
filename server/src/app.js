import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectUpload, readApkManifest, BundleError } from './bundle.js';
import { openDb } from './db.js';
import { createBilling } from './billing.js';
import { createUpdates } from './updates.js';
import { createBackups, BackupError } from './backup/service.js';
import { randomToken, sha256, hashAdminPassword, verifyAdminPassword, hashExitPassword, rateLimiter } from './security.js';
import { checkPassword, cleanTaxId, cleanEmail, cleanPhone, cleanText, TAX_CONDITIONS } from './validate.js';
import { createMailer } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const ONLINE_MS = 70_000;
const SESSION_MS = 12 * 3600_000;
const MESSAGE_TTL_MS = 7 * 24 * 3600_000;
const DAY_MS = 86400_000;
const PRODUCT = 'WiFly MDM';
const SUSPENDED_TITLE = 'Servicio suspendido';
const SUSPENDED_MESSAGE = 'Comuníquese con su proveedor.';
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/png', test: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];
const BULK_COMMANDS = new Set(['message', 'reboot', 'sync', 'install', 'uninstall', 'exitKiosk', 'enterKiosk', 'decommission']);
/** Lo único que puede hacer un operador sobre los equipos. */
const OPERATOR_ACTIONS = new Set(['message', 'lock', 'unlock']);
const ROLE_LABEL = { superadmin: 'administrador general', admin: 'administrador', operator: 'operador' };

const ACTION_LABEL = { assignClient: 'cambio de cliente', message: 'mensaje', lock: 'bloqueo', unlock: 'desbloqueo', assignProfile: 'cambio de perfil', reboot: 'reinicio', sync: 'sincronización', install: 'instalar app', uninstall: 'desinstalar app', exitKiosk: 'salir del kiosko', enterKiosk: 'activar kiosko', decommission: 'baja' };

/** El título vacío muestra el nombre de la empresa en el TV Box. */
const DEFAULT_PROFILE = {
  title: '', showClock: true, allowWifi: true, adbAllowed: false,
  wallpaperSha: '', launcherApkSha: '', apps: [], removePackages: [], helpers: [], exit: null,
};

const DEFAULT_SETTINGS = {
  brandPhrase: '', graceDays: '7', timezone: 'America/Argentina/Buenos_Aires', googleClientId: '', googleClientSecret: '',
  smtpHost: '', smtpPort: '587', smtpSecurity: 'starttls', smtpUser: '', smtpPass: '', smtpFrom: '',
};
const RESET_MS = 60 * 60_000;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
/** Las validaciones lanzan Error común: acá se convierten en un 400 con el mismo mensaje. */
const valid = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, e.message);
  }
};

/** Express 4 no atrapa errores de funciones async: esto los manda al manejador común. */
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => next(e instanceof BackupError ? new HttpError(e.status, e.message) : e));

const USERNAME_RE = /^[A-Za-z0-9._@-]{3,40}$/;

export function createApp({
  dataDir, adminUser = 'admin', adminPassword, secureCookies = false, trustProxy = false,
  longPollMs = 25_000, maxUploadMb = 1024, clock = Date.now, billingIntervalMs = 10 * 60_000, updaterDir = '/updater',
  publicUrl = '', onRestart = () => setTimeout(() => process.exit(0), 800), mailTransport = null,
}) {
  const db = openDb(dataDir);
  const filesDir = path.join(dataDir, 'files');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const q = (sql) => db.prepare(sql);
  const now = () => clock();

  // ---- Configuración general --------------------------------------------------------------
  const getSetting = (key) => q('SELECT value FROM settings WHERE key=?').get(key)?.value ?? DEFAULT_SETTINGS[key];
  const setSetting = (key, value) => q('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const graceMs = () => Number(getSetting('graceDays')) * DAY_MS;
  const billing = createBilling(db, { now, timezone: () => getSetting('timezone') });
  const updates = createUpdates({ dir: updaterDir, version: VERSION, now });
  const mailer = createMailer({ getSetting, transport: mailTransport });

  // ---- Datos iniciales ------------------------------------------------------------------
  let generatedPassword = null;
  if (!q(`SELECT 1 FROM users WHERE role='superadmin' LIMIT 1`).get()) {
    const pass = adminPassword || (generatedPassword = randomToken(12));
    const { salt, hash } = hashAdminPassword(pass);
    q(`INSERT INTO users (username, salt, hash, role, company_id, created_at) VALUES (?,?,?,'superadmin',NULL,?)`).run(adminUser, salt, hash, now());
  }

  const audit = (companyId, actor, action, detail = '') => q('INSERT INTO audit (ts, company_id, actor, action, detail) VALUES (?,?,?,?,?)')
    .run(now(), companyId ?? null, actor, action, String(detail).slice(0, 500));

  // ---- Empresas -------------------------------------------------------------------------
  const companyById = (id) => (id == null ? null : q('SELECT * FROM companies WHERE id=?').get(id));
  /** Los TV Box se suspenden cuando pasan los días de gracia desde que se suspendió el panel. */
  const devicesSuspendAt = (c) => (c && c.status === 'suspended' && c.suspended_at ? c.suspended_at + graceMs() : null);
  const devicesSuspended = (c) => {
    const at = devicesSuspendAt(c);
    return at !== null && now() >= at;
  };

  // ---- Long polling ---------------------------------------------------------------------
  const waiters = new Map();
  const wake = (deviceId) => {
    const w = waiters.get(deviceId);
    if (w) { waiters.delete(deviceId); w(); }
  };
  const wakeWhere = (sql, ...args) => { for (const d of q(`SELECT id FROM devices WHERE ${sql}`).all(...args)) wake(d.id); };
  const wakeProfile = (profileId) => wakeWhere('profile_id = ?', profileId);
  const wakeCompany = (companyId) => wakeWhere('company_id = ?', companyId);
  const wakeAll = () => { for (const id of [...waiters.keys()]) wake(id); };

  // ---- Respaldos ----------------------------------------------------------------------------
  const backups = createBackups({
    db, dataDir, filesDir: path.join(dataDir, 'files'), tmpDir: path.join(dataDir, 'tmp'), version: VERSION, now,
    timezone: () => getSetting('timezone'), getSetting,
    onCompanyRestored: (cid) => wakeCompany(cid),
    onGeneralRestore: () => onRestart(),
  });

  // ---- Archivos ---------------------------------------------------------------------------
  const fileOf = (companyId, sha) => (sha && typeof sha === 'string' ? q('SELECT * FROM files WHERE company_id=? AND sha=?').get(companyId, sha) : null);
  /** Para una app dividida incluye sus partes: el equipo elige las de su arquitectura y las instala juntas. */
  const apkRef = (companyId, sha) => {
    const f = fileOf(companyId, sha);
    if (!f || f.kind !== 'apk') return null;
    const ref = { sha: f.sha, versionCode: f.version_code, size: f.size };
    if (f.parts) ref.parts = JSON.parse(f.parts);
    return ref;
  };
  /** El contenido se guarda una vez por SHA-256 aunque lo suban varias empresas; se borra cuando nadie lo usa. */
  const dropBlobIfUnused = (sha) => {
    if (!q('SELECT 1 FROM files WHERE sha=? LIMIT 1').get(sha)) fs.rmSync(path.join(filesDir, sha), { force: true });
  };

  // ---- Configuración efectiva de cada equipo ---------------------------------------------
  function deviceConfig(device) {
    const company = companyById(device.company_id);
    const row = device.profile_id ? q('SELECT json FROM profiles WHERE id = ? AND company_id = ?').get(device.profile_id, device.company_id) : null;
    const p = { ...DEFAULT_PROFILE, ...(row ? JSON.parse(row.json) : {}) };
    const over = JSON.parse(device.app_overrides);
    const removed = new Set(over.remove);
    const apps = p.apps.filter((a) => !removed.has(a.package));
    for (const pkg of over.add) if (!apps.some((a) => a.package === pkg)) apps.push({ package: pkg });
    const wp = fileOf(device.company_id, p.wallpaperSha);
    const suspended = devicesSuspended(company);
    const cid = device.company_id;
    const cfg = {
      title: p.title || company?.name || 'WiFly',
      brandPhrase: getSetting('brandPhrase'),
      showClock: p.showClock,
      allowWifi: p.allowWifi,
      adbAllowed: p.adbAllowed,
      wallpaper: wp && wp.kind === 'image' ? { sha: wp.sha } : null,
      launcherApk: apkRef(cid, p.launcherApkSha),
      apps: apps.map((a) => ({ package: a.package, label: a.label || '', apk: apkRef(cid, a.apkSha) })),
      removePackages: p.removePackages,
      helpers: p.helpers,
      exit: p.exit,
      // La suspensión por falta de pago usa la misma pantalla de bloqueo, con su texto fijo.
      blocked: suspended || !!device.blocked,
      blockTitle: suspended ? SUSPENDED_TITLE : device.block_title,
      blockMessage: suspended ? SUSPENDED_MESSAGE : device.block_message,
      suspended,
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

  /** Sin sesión: lo usa el actualizador para confirmar que la versión nueva arrancó. */
  app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));

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
    const company = companyById(t.company_id);
    if (!company || devicesSuspended(company)) throw new HttpError(403, 'La empresa de este token está suspendida');
    const deviceToken = randomToken();
    const state = JSON.stringify({ model, manufacturer, androidVersion, sdk });
    const profile = t.profile_id || q('SELECT id FROM profiles WHERE company_id=? ORDER BY id LIMIT 1').get(t.company_id)?.id || null;
    const existing = q('SELECT id, company_id, name FROM devices WHERE install_id = ?').get(installId);
    let id, name;
    if (existing && existing.company_id === t.company_id) {
      ({ id, name } = existing);
      q('UPDATE devices SET token_hash=?, state=?, last_seen=? WHERE id=?').run(sha256(deviceToken), state, now(), id);
      if (t.client_id) q('UPDATE devices SET client_id=? WHERE id=?').run(t.client_id, id);
    } else if (existing) {
      // El equipo pasa a otra empresa: arranca limpio con el perfil y grupo del token nuevo.
      ({ id, name } = existing);
      q(`UPDATE devices SET company_id=?, token_hash=?, state=?, last_seen=?, profile_id=?, grp=?, notes='', blocked=0, block_title='', block_message='',
           app_overrides='{"add":[],"remove":[]}', client_id=? WHERE id=?`).run(t.company_id, sha256(deviceToken), state, now(), profile, t.grp, t.client_id ?? null, id);
      q('DELETE FROM commands WHERE device_id=?').run(id);
      audit(existing.company_id, 'equipo', 'pasó a otra empresa', name);
    } else {
      id = crypto.randomUUID();
      name = `${String(model).slice(0, 40) || 'TV Box'} ${id.slice(0, 4)}`;
      q(`INSERT INTO devices (id, company_id, token_hash, install_id, name, grp, profile_id, state, last_seen, created_at, client_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, t.company_id, sha256(deviceToken), installId, name, t.grp, profile, state, now(), now(), t.client_id ?? null);
    }
    q('UPDATE enroll_tokens SET uses = uses + 1 WHERE token = ?').run(token);
    billing.recordDevice(t.company_id, id, name);
    audit(t.company_id, 'equipo', 'alta', `${model} ${id.slice(0, 4)}`);
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

  const sendStored = (res, companyId, sha) => {
    const f = /^[0-9a-f]{64}$/.test(sha) ? fileOf(companyId, sha) : null;
    if (!f) throw new HttpError(404, 'Archivo inexistente');
    res.set('Content-Type', f.mime);
    res.sendFile(path.join(filesDir, f.sha));
  };
  app.get('/api/device/files/:sha', deviceAuth, (req, res) => sendStored(res, req.device.company_id, req.params.sha));

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
  const suspendedPanel = () => new HttpError(403, 'La empresa está suspendida. Comuníquese con su proveedor.', 'suspended');

  app.post('/api/login', (req, res) => {
    if (loginLimiter.blocked(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
    const { username, password } = req.body || {};
    const u = typeof username === 'string' ? q('SELECT * FROM users WHERE username = ?').get(username.trim()) : null;
    const ok = u && typeof password === 'string' && verifyAdminPassword(password, u.salt, u.hash);
    if (!ok) {
      loginLimiter.hit(req.ip);
      throw new HttpError(401, 'Usuario o clave incorrectos');
    }
    loginLimiter.clear(req.ip);
    if (u.role !== 'superadmin' && companyById(u.company_id)?.status !== 'active') throw suspendedPanel();
    const token = randomToken();
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    q('INSERT INTO sessions (token_hash, user_id, company_id, expires_at) VALUES (?,?,?,?)').run(sha256(token), u.id, u.company_id, now() + SESSION_MS);
    setCookie(res, token, SESSION_MS / 1000);
    audit(u.company_id, u.username, 'ingreso');
    res.json({ username: u.username, role: u.role, displayName: u.display_name || u.full_name || u.username });
  });

  // ---- Recuperación de clave por email ----------------------------------------------------
  const forgotLimiter = rateLimiter({ max: 5, windowMs: 15 * 60_000 });
  const baseUrl = (req) => (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  /** El email de recuperación: el del usuario o, para el administrador de una empresa que no cargó el suyo, el de la empresa. */
  const recoveryEmail = (u) => u.email || (u.role === 'admin' ? companyById(u.company_id)?.email || '' : '');

  app.post('/api/password/forgot', (req, res) => {
    if (forgotLimiter.blocked(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
    forgotLimiter.hit(req.ip);
    const login = String(req.body?.login || '').trim().toLowerCase().slice(0, 120);
    if (!login) throw new HttpError(400, 'Escribí tu usuario o tu email');
    if (!mailer.ready()) throw new HttpError(503, 'La recuperación por email no está configurada. Pedile a un administrador que te cambie la clave.');
    const users = q(`SELECT u.* FROM users u LEFT JOIN companies c ON c.id = u.company_id
                     WHERE lower(u.username) = ? OR lower(u.email) = ? OR (u.role = 'admin' AND u.email = '' AND lower(c.email) = ?)`).all(login, login, login);
    const base = baseUrl(req);
    for (const u of users) {
      const to = recoveryEmail(u);
      if (!to) continue;
      const token = randomToken();
      q('DELETE FROM password_resets WHERE user_id=? OR expires_at < ?').run(u.id, now());
      q('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(token), u.id, now() + RESET_MS);
      const name = u.display_name || u.full_name || u.username;
      // Se envía en segundo plano: la respuesta es la misma exista o no el usuario.
      mailer.send({
        to,
        subject: `${PRODUCT}: recuperar tu clave`,
        text: `Hola ${name}:\n\nPediste recuperar la clave del usuario ${u.username} en ${PRODUCT}.\n\nPara elegir una clave nueva, entrá a este enlace dentro de la próxima hora:\n${base}/#reset=${token}\n\nSi no lo pediste vos, ignorá este correo: tu clave actual sigue funcionando.\n`,
      }).then(() => audit(u.company_id, u.username, 'recuperación de clave enviada', to))
        .catch((e) => { console.error('recuperación de clave', e.message); audit(u.company_id, u.username, 'recuperación de clave: falló el envío', e.message); });
    }
    res.json({ ok: true, message: 'Si el usuario o el email existen y tienen un email cargado, en unos minutos llega un correo con el enlace para elegir una clave nueva. Revisá también la carpeta de spam.' });
  });

  const resetOf = (token) => (typeof token === 'string' && token
    ? q('SELECT r.user_id, u.username, u.display_name, u.full_name, u.company_id FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash=? AND r.expires_at > ?').get(sha256(token), now())
    : null);
  const resetLimiter = rateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const findReset = (req) => {
    if (resetLimiter.blocked(req.ip)) throw new HttpError(429, 'Demasiados intentos. Esperá 15 minutos.');
    const r = resetOf(req.body?.token);
    if (!r) {
      resetLimiter.hit(req.ip);
      throw new HttpError(400, 'El enlace venció o ya se usó. Pedí uno nuevo desde "Olvidé mi clave".');
    }
    return r;
  };
  app.post('/api/password/reset-info', (req, res) => {
    const r = findReset(req);
    res.json({ username: r.username, displayName: r.display_name || r.full_name || r.username });
  });
  app.post('/api/password/reset', (req, res) => {
    const r = findReset(req);
    valid(() => checkPassword(req.body?.password));
    const { salt, hash } = hashAdminPassword(req.body.password);
    q('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, r.user_id);
    q('DELETE FROM password_resets WHERE user_id=?').run(r.user_id);
    q('DELETE FROM sessions WHERE user_id=?').run(r.user_id);
    audit(r.company_id, r.username, 'clave recuperada por email');
    res.json({ ok: true, username: r.username });
  });

  /** Sesión válida + empresa activa. Para el administrador general, la empresa es la que eligió administrar. */
  const auth = (req, res, next) => {
    const token = readCookie(req);
    const s = token ? q(`SELECT u.id, u.username, u.salt, u.hash, u.role, u.full_name, u.display_name, u.email, u.phone,
                                u.company_id AS userCompany, s.company_id AS ctxCompany, s.token_hash
                         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) : null;
    if (!s) return res.status(401).json({ error: 'Sesión vencida' });
    // Un formulario de otro sitio no puede agregar este encabezado.
    if (req.method !== 'GET' && req.get('x-wifly') !== '1') return res.status(403).json({ error: 'Solicitud rechazada' });
    if (s.role === 'superadmin') {
      req.companyId = companyById(s.ctxCompany) ? s.ctxCompany : null;
    } else {
      if (companyById(s.userCompany)?.status !== 'active') {
        q('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
        return res.status(403).json({ error: suspendedPanel().message, code: 'suspended' });
      }
      req.companyId = s.userCompany;
    }
    req.user = s;
    next();
  };
  const isSuper = (req) => req.user.role === 'superadmin';
  /** Rutas de una empresa: el administrador general tiene que haber elegido cuál administrar. */
  const company = (...roles) => [auth, (req, res, next) => {
    if (!req.companyId) return res.status(409).json({ error: 'Elegí una empresa para administrar', code: 'no_company' });
    if (!isSuper(req) && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Tu usuario no tiene permiso para esto' });
    next();
  }];
  const superOnly = [auth, (req, res, next) => (isSuper(req) ? next() : res.status(403).json({ error: 'Solo el administrador general puede hacer esto' }))];
  const ADMIN = company('admin');
  const STAFF = company('admin', 'operator');
  const actor = (req) => req.user.username;

  app.post('/api/logout', auth, (req, res) => {
    q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(readCookie(req)));
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => {
    const c = companyById(req.companyId);
    const u = req.user;
    res.json({
      username: u.username, role: u.role, product: PRODUCT, brandPhrase: getSetting('brandPhrase'),
      fullName: u.full_name, displayName: u.display_name || u.full_name || u.username, email: u.email, phone: u.phone,
      company: c ? { id: c.id, name: c.name, status: c.status } : null,
    });
  });

  /** Cada usuario edita sus propios datos de contacto. */
  app.put('/api/me', auth, (req, res) => {
    const d = valid(() => userData(req.body || {}));
    q('UPDATE users SET full_name=?, display_name=?, phone=?, email=? WHERE id=?').run(d.fullName, d.displayName, d.phone, d.email, req.user.id);
    audit(req.companyId, actor(req), 'datos de usuario actualizados', req.user.username);
    res.json({ ok: true, ...d });
  });

  app.post('/api/password', auth, (req, res) => {
    const { current, next: nextPass } = req.body || {};
    if (typeof current !== 'string' || !verifyAdminPassword(current, req.user.salt, req.user.hash)) throw new HttpError(400, 'La clave actual no es correcta');
    valid(() => checkPassword(nextPass));
    const { salt, hash } = hashAdminPassword(nextPass);
    q('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, req.user.id);
    q('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, sha256(readCookie(req)));
    audit(req.companyId, actor(req), 'cambio de clave');
    res.json({ ok: true });
  });

  /** El administrador general elige qué empresa administrar (o ninguna, para volver a la vista general). */
  app.post('/api/context', superOnly, (req, res) => {
    const id = req.body?.companyId ?? null;
    if (id !== null && !companyById(id)) throw new HttpError(404, 'Empresa inexistente');
    q('UPDATE sessions SET company_id=? WHERE token_hash=?').run(id, sha256(readCookie(req)));
    res.json({ ok: true });
  });

  // ---- Configuración general y empresas (administrador general) ------------------------
  app.get('/api/settings', superOnly, (req, res) => res.json({
    brandPhrase: getSetting('brandPhrase'), graceDays: Number(getSetting('graceDays')),
    googleClientId: getSetting('googleClientId'), googleSecretSet: !!getSetting('googleClientSecret'), googleRedirectUri: googleRedirect(req),
    smtpHost: getSetting('smtpHost'), smtpPort: Number(getSetting('smtpPort')), smtpSecurity: getSetting('smtpSecurity'),
    smtpUser: getSetting('smtpUser'), smtpPassSet: !!getSetting('smtpPass'), smtpFrom: getSetting('smtpFrom'), mailReady: mailer.ready(),
  }));
  app.put('/api/settings', superOnly, (req, res) => {
    const b = req.body || {};
    const phrase = String(b.brandPhrase ?? '').trim().slice(0, 40);
    const grace = Number(b.graceDays);
    if (!Number.isInteger(grace) || grace < 0 || grace > 365) throw new HttpError(400, 'Los días de gracia van de 0 a 365');
    setSetting('brandPhrase', phrase);
    setSetting('graceDays', grace);
    if (b.googleClientId !== undefined) setSetting('googleClientId', String(b.googleClientId).trim().slice(0, 200));
    if (b.googleClientSecret) setSetting('googleClientSecret', String(b.googleClientSecret).trim().slice(0, 200));
    if (b.smtpHost !== undefined) {
      const host = String(b.smtpHost).trim().slice(0, 200);
      const port = Number(b.smtpPort);
      if (host && !/^[A-Za-z0-9.-]+$/.test(host)) throw new HttpError(400, 'El servidor SMTP es un nombre o una IP, como smtp.gmail.com');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'El puerto SMTP va de 1 a 65535');
      const from = String(b.smtpFrom || '').trim().slice(0, 160);
      if (host && !from) throw new HttpError(400, 'Poné el remitente, por ejemplo WiFly MDM <avisos@miempresa.com>');
      if (/[\r\n]/.test(from) || (from && !/[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/.test(from))) throw new HttpError(400, 'El remitente tiene que incluir un email válido');
      setSetting('smtpHost', host);
      setSetting('smtpPort', port);
      setSetting('smtpSecurity', b.smtpSecurity === 'tls' ? 'tls' : 'starttls');
      setSetting('smtpUser', String(b.smtpUser || '').trim().slice(0, 200));
      setSetting('smtpFrom', from);
      if (b.smtpPass) setSetting('smtpPass', String(b.smtpPass).slice(0, 200));
      audit(null, actor(req), 'correo saliente configurado', host || 'desactivado');
    }
    audit(null, actor(req), 'configuración', `frase "${phrase}", ${grace} días de gracia`);
    wakeAll();
    res.json({ brandPhrase: phrase, graceDays: grace });
  });

  /** Correo de prueba al email del administrador que lo pide, para confirmar la configuración SMTP. */
  app.post('/api/settings/mail-test', superOnly, aw(async (req, res) => {
    const to = cleanEmail(req.body?.to) || req.user.email;
    if (!to) throw new HttpError(400, 'Cargá tu email en Cuenta o escribí a dónde mandar la prueba');
    if (!mailer.ready()) throw new HttpError(400, 'Primero guardá el servidor SMTP y el remitente');
    try {
      await mailer.send({ to, subject: `${PRODUCT}: correo de prueba`, text: `Este es un correo de prueba de ${PRODUCT}.\n\nSi lo recibiste, la recuperación de claves por email ya funciona.\n` });
    } catch (e) {
      throw new HttpError(502, `El servidor de correo respondió: ${e.message}`);
    }
    audit(null, actor(req), 'correo de prueba', to);
    res.json({ ok: true, to });
  }));

  const presentCompany = (c, counts) => {
    const n = (sql) => q(`SELECT COUNT(*) AS n FROM devices WHERE company_id=? ${sql}`).get(c.id, ...(sql ? [now() - ONLINE_MS] : [])).n;
    return {
      id: c.id, name: c.name, status: c.status, notes: c.notes, createdAt: c.created_at,
      legalName: c.legal_name, taxAddress: c.tax_address, taxCondition: c.tax_condition, taxConditionLabel: TAX_CONDITIONS[c.tax_condition] || '',
      taxId: c.tax_id, email: c.email, phone: c.phone,
      clients: q('SELECT COUNT(*) AS n FROM clients WHERE company_id=?').get(c.id).n,
      suspendedAt: c.suspended_at, devicesSuspendAt: devicesSuspendAt(c), devicesSuspended: devicesSuspended(c),
      devices: n(''), online: n('AND last_seen > ?'), monthDevices: counts.get(c.id) || 0,
      admins: q(`SELECT username FROM users WHERE company_id=? AND role='admin' ORDER BY username`).all(c.id).map((u) => u.username),
    };
  };

  app.get('/api/companies', superOnly, (req, res) => {
    const counts = billing.monthCounts(billing.currentMonth());
    res.json(q('SELECT * FROM companies ORDER BY name').all().map((c) => presentCompany(c, counts)));
  });

  const companyName = (b) => {
    const name = String(b?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Poné el nombre de la empresa');
    return name;
  };
  /** Datos fiscales y de contacto. Al crear son obligatorios; al editar, una empresa vieja puede quedar incompleta. */
  const companyData = (b, required) => valid(() => {
    const cond = String(b.taxCondition || '');
    if (cond && !TAX_CONDITIONS[cond]) throw new Error('Elegí el tipo de impuesto');
    if (required && !cond) throw new Error('Elegí el tipo de impuesto: consumidor final, monotributista o responsable inscripto');
    return {
      legalName: cleanText(b.legalName, 120, { required, label: 'la razón social' }),
      taxAddress: cleanText(b.taxAddress, 200, { required, label: 'el domicilio fiscal' }),
      taxCondition: cond,
      taxId: cleanTaxId(b.taxId, { required, cuitOnly: cond === 'mono' || cond === 'ri' }),
      email: cleanEmail(b.email, { required }),
      phone: cleanPhone(b.phone, { required }),
    };
  });
  const getCompany = (id) => {
    const c = companyById(Number(id));
    if (!c) throw new HttpError(404, 'Empresa inexistente');
    return c;
  };

  /** Datos personales de un usuario del panel. El nombre a mostrar, si falta, es el nombre completo. */
  function userData(b) {
    const fullName = cleanText(b.fullName, 80, { required: true, label: 'el nombre completo' });
    return {
      fullName,
      displayName: cleanText(b.displayName, 40) || fullName.slice(0, 40),
      phone: cleanPhone(b.phone),
      email: cleanEmail(b.email, { required: true }),
    };
  }

  function createUser(b, role, companyId) {
    const u = String(b.username || '').trim();
    if (!USERNAME_RE.test(u)) throw new HttpError(400, 'El usuario va de 3 a 40 caracteres: letras, números, punto, guion, guion bajo o @');
    const d = valid(() => userData(b));
    valid(() => checkPassword(b.password));
    if (q('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(u)) throw new HttpError(409, `Ya existe el usuario ${u}`);
    const { salt, hash } = hashAdminPassword(b.password);
    return q(`INSERT INTO users (username, salt, hash, role, company_id, created_at, full_name, display_name, phone, email) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(u, salt, hash, role, companyId, now(), d.fullName, d.displayName, d.phone, d.email).lastInsertRowid;
  }

  app.post('/api/companies', superOnly, (req, res) => {
    const b = req.body || {};
    const name = companyName(b);
    if (q('SELECT 1 FROM companies WHERE name=?').get(name)) throw new HttpError(409, 'Ya existe una empresa con ese nombre');
    const data = companyData(b, true);
    db.exec('BEGIN');
    let id;
    try {
      id = q(`INSERT INTO companies (name, notes, created_at, legal_name, tax_address, tax_condition, tax_id, email, phone) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(name, String(b.notes || '').slice(0, 500), now(), data.legalName, data.taxAddress, data.taxCondition, data.taxId, data.email, data.phone).lastInsertRowid;
      q('INSERT INTO profiles (company_id, name, json, updated_at) VALUES (?,?,?,?)').run(id, 'General', JSON.stringify(DEFAULT_PROFILE), now());
      // El administrador usa por defecto el email de la empresa: así recupera su clave aunque no cargue uno propio.
      const a = b.admin || (b.adminUser ? { username: b.adminUser, password: b.adminPassword } : null);
      if (a?.username) createUser({ ...a, email: a.email || data.email, phone: a.phone || data.phone }, 'admin', id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    audit(id, actor(req), 'empresa creada', name);
    res.json(presentCompany(companyById(id), billing.monthCounts(billing.currentMonth())));
  });

  app.patch('/api/companies/:id', superOnly, (req, res) => {
    const c = getCompany(req.params.id);
    const name = req.body?.name !== undefined ? companyName(req.body) : c.name;
    const clash = q('SELECT id FROM companies WHERE name=?').get(name);
    if (clash && clash.id !== c.id) throw new HttpError(409, 'Ya existe una empresa con ese nombre');
    const notes = req.body?.notes !== undefined ? String(req.body.notes).slice(0, 500) : c.notes;
    const cur = { legalName: c.legal_name, taxAddress: c.tax_address, taxCondition: c.tax_condition, taxId: c.tax_id, email: c.email, phone: c.phone };
    const data = companyData({ ...cur, ...req.body }, false);
    q('UPDATE companies SET name=?, notes=?, legal_name=?, tax_address=?, tax_condition=?, tax_id=?, email=?, phone=? WHERE id=?')
      .run(name, notes, data.legalName, data.taxAddress, data.taxCondition, data.taxId, data.email, data.phone, c.id);
    if (name !== c.name) audit(c.id, actor(req), 'empresa renombrada', `${c.name} → ${name}`);
    wakeCompany(c.id);
    res.json(presentCompany(companyById(c.id), billing.monthCounts(billing.currentMonth())));
  });

  /** Suspender: el panel de la empresa se corta ya; sus TV Box, al vencer los días de gracia. */
  app.post('/api/companies/:id/suspend', superOnly, (req, res) => {
    const c = getCompany(req.params.id);
    if (c.status !== 'suspended') {
      q(`UPDATE companies SET status='suspended', suspended_at=? WHERE id=?`).run(now(), c.id);
      q('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id=?)').run(c.id);
      audit(c.id, actor(req), 'empresa suspendida', `TV Box suspendidos en ${getSetting('graceDays')} días si no paga`);
    }
    wakeCompany(c.id);
    res.json(presentCompany(companyById(c.id), billing.monthCounts(billing.currentMonth())));
  });

  /** Marcar pagada: vuelven el panel y los TV Box. */
  app.post('/api/companies/:id/activate', superOnly, (req, res) => {
    const c = getCompany(req.params.id);
    q(`UPDATE companies SET status='active', suspended_at=NULL WHERE id=?`).run(c.id);
    if (c.status !== 'active') audit(c.id, actor(req), 'empresa reactivada', 'pago registrado');
    wakeCompany(c.id);
    res.json(presentCompany(companyById(c.id), billing.monthCounts(billing.currentMonth())));
  });

  app.delete('/api/companies/:id', superOnly, (req, res) => {
    const c = getCompany(req.params.id);
    if (q('SELECT 1 FROM devices WHERE company_id=? LIMIT 1').get(c.id)) throw new HttpError(409, 'La empresa todavía tiene equipos. Eliminá o dá de baja sus equipos primero.');
    const shas = q('SELECT sha FROM files WHERE company_id=?').all(c.id).map((r) => r.sha);
    q('DELETE FROM companies WHERE id=?').run(c.id);
    for (const sha of shas) dropBlobIfUnused(sha);
    backups.forgetCompany(c.id);
    audit(null, actor(req), 'empresa eliminada', c.name);
    res.json({ ok: true });
  });

  // ---- Actualizaciones desde GitHub (administrador general) --------------------------------
  const updateCall = (fn) => (req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      throw new HttpError(e.status || 500, e.message);
    }
  };
  app.get('/api/updates', superOnly, (req, res) => res.json(updates.status()));
  app.post('/api/updates/check', superOnly, updateCall((req) => {
    const s = updates.request('check');
    audit(null, actor(req), 'buscar actualizaciones');
    return s;
  }));
  app.post('/api/updates/apply', superOnly, updateCall((req) => {
    const target = String(req.body?.version || '');
    const s = updates.request('update', target);
    audit(null, actor(req), 'actualización pedida', `${s.current} → ${target}`);
    return s;
  }));

  // ---- Respaldos: "general" (administrador general) o "empresa" (la empresa que se administra) ------
  const googleRedirect = (req) => `${(publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/backups/google/callback`;
  /** Resuelve el alcance y controla el permiso. Los operadores nunca acceden a respaldos. */
  const backupScope = [auth, (req, res, next) => {
    const scope = req.params.scope;
    if (scope === 'general') {
      if (!isSuper(req)) return res.status(403).json({ error: 'Solo el administrador general maneja el respaldo del sistema' });
      req.backupKey = backups.keyFor(null);
    } else if (scope === 'empresa') {
      if (!req.companyId) return res.status(409).json({ error: 'Elegí una empresa para administrar', code: 'no_company' });
      if (!isSuper(req) && req.user.role !== 'admin') return res.status(403).json({ error: 'Tu usuario no tiene permiso para esto' });
      req.backupKey = backups.keyFor(req.companyId);
    } else {
      return res.status(404).json({ error: 'Ruta inexistente' });
    }
    next();
  }];
  const auditKey = (req) => (req.backupKey === 'general' ? null : req.companyId);

  app.get('/api/backups/google/callback', aw(async (req, res) => {
    const back = (msg, ok) => res.redirect(`/#backups-google=${ok ? 'ok' : 'error'}&msg=${encodeURIComponent(msg)}`);
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'Cancelaste la conexión con Google' : `Google respondió: ${req.query.error}`, false);
    try {
      const r = await backups.googleCallback(String(req.query.state || ''), String(req.query.code || ''));
      audit(r.key === 'general' ? null : Number(r.key.slice(8)), 'google', 'Google Drive conectado', r.email);
      return back(`Google Drive conectado${r.email ? ` como ${r.email}` : ''}`, true);
    } catch (e) {
      return back(e.message, false);
    }
  }));

  app.get('/api/backups/:scope', backupScope, (req, res) => res.json({ ...backups.present(req.backupKey), googleRedirectUri: googleRedirect(req) }));
  app.put('/api/backups/:scope', backupScope, aw(async (req, res) => {
    const r = backups.save(req.backupKey, req.body || {});
    audit(auditKey(req), actor(req), 'respaldos configurados', req.backupKey === 'general' ? 'sistema' : 'empresa');
    res.json({ ...r, googleRedirectUri: googleRedirect(req) });
  }));
  app.post('/api/backups/:scope/test/:destId', backupScope, aw(async (req, res) => res.json(await backups.test(req.backupKey, req.params.destId))));
  app.post('/api/backups/:scope/run', backupScope, aw(async (req, res) => {
    const { id, done } = backups.start(req.backupKey, 'manual', actor(req));
    audit(auditKey(req), actor(req), 'respaldo manual', req.backupKey === 'general' ? 'sistema' : 'empresa');
    done.catch(() => {});
    res.json({ id });
  }));
  app.get('/api/backups/:scope/remote', backupScope, aw(async (req, res) => res.json(await backups.remote(req.backupKey))));
  app.get('/api/backups/:scope/google/start/:destId', backupScope, aw(async (req, res) => res.json({ url: backups.googleStart(req.backupKey, req.params.destId, googleRedirect(req)) })));
  app.get('/api/backups/:scope/download/:destId/:name', backupScope, aw(async (req, res) => {
    const file = await backups.download(req.backupKey, req.params.destId, req.params.name);
    res.download(file, req.params.name, () => fs.rmSync(file, { force: true }));
  }));

  const restoreDone = (req, res, r) => {
    audit(auditKey(req), actor(req), 'respaldo restaurado', r.kind === 'general' ? 'sistema completo' : `${r.devices} equipos, ${r.profiles} perfiles${r.skipped.length ? `; omitido: ${r.skipped.join(', ')}` : ''}`);
    res.json(r);
  };
  app.post('/api/backups/:scope/restore', backupScope, aw(async (req, res) => {
    const { destId, name, password } = req.body || {};
    restoreDone(req, res, await backups.restoreRemote(req.backupKey, String(destId || ''), String(name || ''), String(password || '')));
  }));
  const backupUpload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: maxUploadMb * 4 * 1024 * 1024 } });
  app.post('/api/backups/:scope/restore-file', backupScope, backupUpload.single('file'), aw(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Elegí el archivo de respaldo (.wfbk)');
    try {
      restoreDone(req, res, await backups.restoreFile(req.backupKey, req.file.path, String(req.body.password || '')));
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  }));

  // ---- Facturación ------------------------------------------------------------------------
  function billingReport(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Mes inválido');
    const counts = billing.monthCounts(month);
    const companies = q('SELECT id, name, status, legal_name, tax_id, tax_condition FROM companies ORDER BY name').all();
    // Una empresa eliminada que facturó ese mes sigue apareciendo con su número.
    const rows = companies.map((c) => ({ companyId: c.id, name: c.name, legalName: c.legal_name, taxId: c.tax_id, taxCondition: TAX_CONDITIONS[c.tax_condition] || '', status: c.status, devices: counts.get(c.id) || 0 }));
    for (const [cid, n] of counts) if (!companies.some((c) => c.id === cid)) rows.push({ companyId: cid, name: `Empresa eliminada #${cid}`, legalName: '', taxId: '', taxCondition: '', status: 'deleted', devices: n });
    return { month, closed: billing.isClosed(month), months: billing.months(), rows, total: rows.reduce((t, r) => t + r.devices, 0) };
  }

  app.get('/api/billing', superOnly, (req, res) => res.json(billingReport(String(req.query.month || billing.currentMonth()))));

  /** CSV con punto y coma y BOM: Excel en español lo abre directo en columnas. */
  const sendCsv = (res, filename, header, rows) => {
    const cell = (v) => {
      const s = String(v ?? '');
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`﻿${text}\r\n`);
  };
  const STATUS_LABEL = { active: 'Activa', suspended: 'Suspendida', deleted: 'Eliminada' };

  app.get('/api/billing.csv', superOnly, (req, res) => {
    const r = billingReport(String(req.query.month || billing.currentMonth()));
    sendCsv(res, `facturacion-${r.month}.csv`, ['Mes', 'Empresa', 'Razón social', 'CUIT/DNI', 'Tipo de impuesto', 'Estado', 'Equipos facturables', 'Mes cerrado'],
      [...r.rows.map((x) => [r.month, x.name, x.legalName, x.taxId, x.taxCondition, STATUS_LABEL[x.status] || x.status, x.devices, r.closed ? 'Sí' : 'No, en curso']), [r.month, 'TOTAL', '', '', '', '', r.total, '']]);
  });

  app.get('/api/billing/:companyId/devices.csv', superOnly, (req, res) => {
    const month = String(req.query.month || billing.currentMonth());
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Mes inválido');
    const cid = Number(req.params.companyId);
    const name = companyById(cid)?.name || `empresa-${cid}`;
    const detail = billing.deviceDetail(cid, month);
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
    sendCsv(res, `equipos-${safe}-${month}.csv`, ['Mes', 'Empresa', 'Equipo', 'Primer día', 'Último día', 'Días registrado', 'ID'],
      detail.map((d) => [month, name, d.name, d.firstDay, d.lastDay, d.days, d.deviceId]));
  });

  // ---- Usuarios -------------------------------------------------------------------------
  const presentUser = (u) => ({
    id: u.id, username: u.username, role: u.role, roleLabel: ROLE_LABEL[u.role], createdAt: u.created_at,
    fullName: u.full_name, displayName: u.display_name || u.full_name, phone: u.phone, email: u.email,
  });

  /** Sin empresa elegida, el administrador general ve a los otros administradores generales. */
  app.get('/api/users', auth, (req, res) => {
    if (isSuper(req) && !req.companyId) return res.json(q(`SELECT * FROM users WHERE role='superadmin' ORDER BY username`).all().map(presentUser));
    if (!req.companyId || (!isSuper(req) && req.user.role !== 'admin')) throw new HttpError(403, 'Tu usuario no tiene permiso para esto');
    res.json(q('SELECT * FROM users WHERE company_id=? ORDER BY role, username').all(req.companyId).map(presentUser));
  });

  /** Quién puede gestionar a quién: el general a todos; el administrador de empresa, solo a sus operadores. */
  const canManage = (req, role) => (isSuper(req) ? true : req.user.role === 'admin' && role === 'operator');

  app.post('/api/users', auth, (req, res) => {
    const b = req.body || {};
    const { username, role } = b;
    if (!ROLE_LABEL[role]) throw new HttpError(400, 'Rol inválido');
    if (!canManage(req, role)) throw new HttpError(403, 'Tu usuario no puede crear ese tipo de usuario');
    const companyId = role === 'superadmin' ? null : req.companyId;
    if (role !== 'superadmin' && !companyId) throw new HttpError(409, 'Elegí una empresa para administrar', 'no_company');
    const id = createUser(b, role, companyId);
    audit(companyId, actor(req), 'usuario creado', `${username} (${ROLE_LABEL[role]})`);
    res.json(presentUser(q('SELECT * FROM users WHERE id=?').get(id)));
  });

  const manageableUser = (req, id) => {
    const u = q('SELECT * FROM users WHERE id=?').get(Number(id));
    if (!u) throw new HttpError(404, 'Usuario inexistente');
    const sameScope = u.role === 'superadmin' ? isSuper(req) : u.company_id === req.companyId || isSuper(req);
    if (!sameScope || !canManage(req, u.role)) throw new HttpError(403, 'Tu usuario no puede modificar a ese usuario');
    return u;
  };

  app.patch('/api/users/:id', auth, (req, res) => {
    const u = manageableUser(req, req.params.id);
    const d = valid(() => userData({ fullName: u.full_name, displayName: u.display_name, phone: u.phone, email: u.email, ...req.body }));
    q('UPDATE users SET full_name=?, display_name=?, phone=?, email=? WHERE id=?').run(d.fullName, d.displayName, d.phone, d.email, u.id);
    audit(u.company_id, actor(req), 'datos de usuario actualizados', u.username);
    res.json(presentUser(q('SELECT * FROM users WHERE id=?').get(u.id)));
  });

  app.post('/api/users/:id/password', auth, (req, res) => {
    const u = manageableUser(req, req.params.id);
    const pass = req.body?.password;
    valid(() => checkPassword(pass));
    const { salt, hash } = hashAdminPassword(pass);
    q('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hash, u.id);
    q('DELETE FROM sessions WHERE user_id=?').run(u.id);
    audit(u.company_id, actor(req), 'clave reiniciada', u.username);
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', auth, (req, res) => {
    const u = manageableUser(req, req.params.id);
    if (u.id === req.user.id) throw new HttpError(400, 'No podés eliminar tu propio usuario');
    if (u.role === 'superadmin' && q(`SELECT COUNT(*) AS n FROM users WHERE role='superadmin'`).get().n <= 1) throw new HttpError(400, 'Tiene que quedar al menos un administrador general');
    q('DELETE FROM users WHERE id=?').run(u.id);
    audit(u.company_id, actor(req), 'usuario eliminado', u.username);
    res.json({ ok: true });
  });

  // ---- Equipos ----------------------------------------------------------------------------
  const clientRow = (id) => (id == null ? null : q('SELECT id, ext_id, name FROM clients WHERE id=?').get(id));
  const presentDevice = (d) => {
    const client = clientRow(d.client_id);
    const state = JSON.parse(d.state);
    const profile = d.profile_id ? q('SELECT name, json FROM profiles WHERE id=?').get(d.profile_id) : null;
    const pj = profile ? JSON.parse(profile.json) : {};
    const cfg = deviceConfig(d);
    return {
      id: d.id, name: d.name, group: d.grp, notes: d.notes, profileId: d.profile_id, profileName: profile?.name || '',
      blocked: !!d.blocked, blockTitle: d.block_title, blockMessage: d.block_message, suspended: cfg.suspended,
      overrides: JSON.parse(d.app_overrides), state, publicIp: d.public_ip, lastSeen: d.last_seen, createdAt: d.created_at,
      online: waiters.has(d.id) || now() - d.last_seen < ONLINE_MS,
      synced: state.appliedConfig === cfg.version,
      wallpaperSha: pj.wallpaperSha || '', title: cfg.title, effectiveApps: cfg.apps.map((a) => a.package),
      clientId: client?.id ?? null, clientExtId: client?.ext_id || '', clientName: client?.name || '',
    };
  };

  app.get('/api/devices', STAFF, (req, res) => {
    res.json(q('SELECT * FROM devices WHERE company_id=? ORDER BY grp, name').all(req.companyId).map(presentDevice));
  });

  const getDevice = (req, id) => {
    const d = q('SELECT * FROM devices WHERE id=? AND company_id=?').get(id, req.companyId);
    if (!d) throw new HttpError(404, 'Equipo inexistente');
    return d;
  };

  app.get('/api/devices/:id', STAFF, (req, res) => {
    expireOld();
    const d = getDevice(req, req.params.id);
    const commands = q('SELECT type, payload, status, detail, created_at AS createdAt, updated_at AS updatedAt FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 30').all(d.id)
      .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));
    res.json({ ...presentDevice(d), commands });
  });

  const validPackage = (p) => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(p);
  const profileOf = (req, id) => (id == null ? null : q('SELECT * FROM profiles WHERE id=? AND company_id=?').get(id, req.companyId));
  const clientOf = (req, id) => (id == null ? null : q('SELECT * FROM clients WHERE id=? AND company_id=?').get(Number(id), req.companyId));

  app.patch('/api/devices/:id', ADMIN, (req, res) => {
    const d = getDevice(req, req.params.id);
    const b = req.body || {};
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : d.name;
    const grp = typeof b.group === 'string' ? b.group.trim().slice(0, 60) : d.grp;
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 500) : d.notes;
    let profileId = d.profile_id;
    if (b.profileId !== undefined) {
      if (b.profileId !== null && !profileOf(req, b.profileId)) throw new HttpError(400, 'Perfil inexistente');
      profileId = b.profileId;
    }
    let clientId = d.client_id;
    if (b.clientId !== undefined) {
      if (b.clientId !== null && !clientOf(req, b.clientId)) throw new HttpError(400, 'Cliente inexistente');
      clientId = b.clientId;
    }
    let overrides = d.app_overrides;
    if (b.overrides) {
      const clean = (l) => (Array.isArray(l) ? l.filter(validPackage) : []);
      overrides = JSON.stringify({ add: clean(b.overrides.add), remove: clean(b.overrides.remove) });
    }
    q('UPDATE devices SET name=?, grp=?, notes=?, profile_id=?, app_overrides=?, client_id=? WHERE id=?').run(name, grp, notes, profileId, overrides, clientId, d.id);
    wake(d.id);
    res.json(presentDevice(getDevice(req, d.id)));
  });

  app.delete('/api/devices/:id', ADMIN, (req, res) => {
    const d = getDevice(req, req.params.id);
    q('DELETE FROM devices WHERE id=?').run(d.id);
    wake(d.id);
    audit(req.companyId, actor(req), 'equipo eliminado', d.name);
    res.json({ ok: true });
  });

  function validateCommand(req, action, payload) {
    if (action === 'message') {
      const title = String(payload.title || '').slice(0, 80);
      const body = String(payload.body || '').slice(0, 1000);
      if (!body.trim()) throw new HttpError(400, 'Escribí el texto del mensaje');
      const seconds = Math.max(0, Math.min(3600, Number(payload.seconds) || 0));
      return { title, body, seconds, mode: payload.mode === 'banner' ? 'banner' : 'modal' };
    }
    if (action === 'install') {
      const ref = apkRef(req.companyId, payload.sha);
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
  app.post('/api/devices/bulk', STAFF, (req, res) => {
    const { ids, action, payload = {} } = req.body || {};
    if (req.user.role === 'operator' && !OPERATOR_ACTIONS.has(action)) throw new HttpError(403, 'Un operador solo puede enviar mensajes, bloquear y desbloquear');
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Seleccioná al menos un equipo');
    const devices = ids.map((id) => q('SELECT id, name FROM devices WHERE id=? AND company_id=?').get(id, req.companyId)).filter(Boolean);
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
    } else if (action === 'assignClient') {
      const cid = payload.clientId ?? null;
      if (cid !== null && !clientOf(req, cid)) throw new HttpError(400, 'Cliente inexistente');
      for (const d of devices) q('UPDATE devices SET client_id=? WHERE id=?').run(cid, d.id);
    } else if (action === 'assignProfile') {
      if (!profileOf(req, payload.profileId)) throw new HttpError(400, 'Perfil inexistente');
      for (const d of devices) {
        q('UPDATE devices SET profile_id=? WHERE id=?').run(payload.profileId, d.id);
        wake(d.id);
      }
    } else if (BULK_COMMANDS.has(action)) {
      const clean = JSON.stringify(validateCommand(req, action, payload));
      for (const d of devices) {
        q(`INSERT INTO commands (id, device_id, batch_id, type, payload, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(crypto.randomUUID(), d.id, batch, action, clean, now(), now(), now() + MESSAGE_TTL_MS);
        wake(d.id);
      }
    } else {
      throw new HttpError(400, 'Acción desconocida');
    }
    audit(req.companyId, actor(req), ACTION_LABEL[action] || action, `${devices.length} equipo(s): ${devices.map((d) => d.name).join(', ')}`);
    res.json({ ok: true, count: devices.length, batch });
  });

  app.get('/api/sends', STAFF, (req, res) => {
    expireOld();
    const rows = q(`SELECT c.batch_id AS batch, c.type, c.payload, c.status, c.detail, c.created_at AS createdAt, d.name AS device
                    FROM commands c JOIN devices d ON d.id = c.device_id WHERE d.company_id=? ORDER BY c.created_at DESC LIMIT 500`).all(req.companyId);
    const batches = new Map();
    for (const r of rows) {
      if (!batches.has(r.batch)) batches.set(r.batch, { batch: r.batch, type: r.type, payload: JSON.parse(r.payload), createdAt: r.createdAt, items: [] });
      batches.get(r.batch).items.push({ device: r.device, status: r.status, detail: r.detail });
    }
    res.json([...batches.values()]);
  });

  /** Actividad: la de la empresa elegida, o la general si el administrador general no eligió ninguna. */
  app.get('/api/audit', auth, (req, res) => {
    if (req.user.role === 'operator') throw new HttpError(403, 'Tu usuario no tiene permiso para esto');
    const rows = req.companyId
      ? q('SELECT ts, actor, action, detail FROM audit WHERE company_id=? ORDER BY id DESC LIMIT 200').all(req.companyId)
      : q(`SELECT a.ts, a.actor, a.action, a.detail, c.name AS company FROM audit a LEFT JOIN companies c ON c.id = a.company_id ORDER BY a.id DESC LIMIT 200`).all();
    res.json(rows);
  });

  // Apps conocidas: lo que informan los equipos más la biblioteca. Alimenta el selector de perfiles.
  app.get('/api/known-apps', ADMIN, (req, res) => {
    const known = new Map();
    for (const d of q('SELECT state FROM devices WHERE company_id=?').all(req.companyId)) {
      for (const a of JSON.parse(d.state).apps || []) {
        if (a.home) continue; // El launcher original nunca se ofrece como app permitida.
        if (!known.has(a.package)) known.set(a.package, { package: a.package, label: a.label, devices: 0 });
        known.get(a.package).devices++;
      }
    }
    for (const f of q(`SELECT * FROM files WHERE kind='apk' AND company_id=?`).all(req.companyId)) {
      if (!known.has(f.package)) known.set(f.package, { package: f.package, label: f.name, devices: 0 });
    }
    res.json([...known.values()].sort((a, b) => a.label.localeCompare(b.label)));
  });

  // ---- Perfiles ---------------------------------------------------------------------------
  function cleanProfile(req, b, previous) {
    const cid = req.companyId;
    const list = (l) => (Array.isArray(l) ? [...new Set(l.filter(validPackage))] : []);
    const apps = (Array.isArray(b.apps) ? b.apps : []).filter((a) => a && validPackage(a.package)).map((a) => ({
      package: a.package, label: String(a.label || '').slice(0, 80), apkSha: apkRef(cid, a.apkSha) ? a.apkSha : '',
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
      title: String(b.title ?? '').trim().slice(0, 60),
      showClock: b.showClock !== false,
      allowWifi: b.allowWifi !== false,
      adbAllowed: b.adbAllowed === true,
      wallpaperSha: fileOf(cid, b.wallpaperSha)?.kind === 'image' ? b.wallpaperSha : '',
      launcherApkSha: apkRef(cid, b.launcherApkSha) ? b.launcherApkSha : '',
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

  app.get('/api/profiles', ADMIN, (req, res) => res.json(q('SELECT * FROM profiles WHERE company_id=? ORDER BY name').all(req.companyId).map(presentProfile)));

  app.post('/api/profiles', ADMIN, (req, res) => {
    const name = profileName(req.body);
    if (q('SELECT 1 FROM profiles WHERE name=? AND company_id=?').get(name, req.companyId)) throw new HttpError(409, 'Ya existe un perfil con ese nombre');
    const r = q('INSERT INTO profiles (company_id, name, json, updated_at) VALUES (?,?,?,?)').run(req.companyId, name, JSON.stringify(cleanProfile(req, req.body, null)), now());
    audit(req.companyId, actor(req), 'perfil creado', name);
    res.json(presentProfile(q('SELECT * FROM profiles WHERE id=?').get(r.lastInsertRowid)));
  });

  app.put('/api/profiles/:id', ADMIN, (req, res) => {
    const row = profileOf(req, Number(req.params.id));
    if (!row) throw new HttpError(404, 'Perfil inexistente');
    const name = profileName(req.body);
    const clash = q('SELECT id FROM profiles WHERE name=? AND company_id=?').get(name, req.companyId);
    if (clash && clash.id !== row.id) throw new HttpError(409, 'Ya existe un perfil con ese nombre');
    q('UPDATE profiles SET name=?, json=?, updated_at=? WHERE id=?').run(name, JSON.stringify(cleanProfile(req, req.body, JSON.parse(row.json))), now(), row.id);
    wakeProfile(row.id);
    audit(req.companyId, actor(req), 'perfil guardado', name);
    res.json(presentProfile(q('SELECT * FROM profiles WHERE id=?').get(row.id)));
  });

  app.delete('/api/profiles/:id', ADMIN, (req, res) => {
    const row = profileOf(req, Number(req.params.id));
    if (!row) throw new HttpError(404, 'Perfil inexistente');
    if (q('SELECT COUNT(*) AS n FROM devices WHERE profile_id=?').get(row.id).n) throw new HttpError(409, 'Pasá los equipos a otro perfil antes de eliminar este');
    q('DELETE FROM profiles WHERE id=?').run(row.id);
    audit(req.companyId, actor(req), 'perfil eliminado', row.name);
    res.json({ ok: true });
  });

  // ---- Archivos ---------------------------------------------------------------------------
  const upload = multer({ dest: tmpDir, limits: { fileSize: maxUploadMb * 1024 * 1024 } });
  const presentFile = (f) => ({ sha: f.sha, kind: f.kind, name: f.name, size: f.size, package: f.package, versionCode: f.version_code, versionName: f.version_name, createdAt: f.created_at, parts: f.parts ? JSON.parse(f.parts).length : 0 });
  const labelOf = (m, fallback) => (typeof m.application?.label === 'string' && !m.application.label.startsWith('resourceId:') ? m.application.label : fallback);
  const insertFile = q(`INSERT OR REPLACE INTO files (company_id, sha, kind, name, size, mime, package, version_code, version_name, parts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const APK_MIME = 'application/vnd.android.package-archive';
  /** Si el contenido ya está guardado (otra empresa subió el mismo archivo), no se duplica en disco. */
  const storeBlob = (tmp, sha) => {
    const dest = path.join(filesDir, sha);
    if (fs.existsSync(dest)) fs.unlinkSync(tmp);
    else fs.renameSync(tmp, dest);
  };

  const hashFile = (p) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

  app.post('/api/files', ADMIN, upload.single('file'), async (req, res, next) => {
    const tmp = req.file?.path;
    const cid = req.companyId;
    try {
      if (!tmp) throw new HttpError(400, 'Elegí un archivo');
      const fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 120);
      const sha = await hashFile(tmp);
      const image = IMAGE_MAGIC.find((m) => m.test(head));
      if (req.body.kind === 'image') {
        if (!image) throw new HttpError(400, 'La imagen tiene que ser JPG, PNG o WebP');
        storeBlob(tmp, sha);
        insertFile.run(cid, sha, 'image', original, req.file.size, image.mime, null, null, null, null, now());
        audit(cid, actor(req), 'archivo subido', `imagen ${original}`);
        return res.json(presentFile(fileOf(cid, sha)));
      }
      if (req.body.kind !== 'apk') throw new HttpError(400, 'Tipo de archivo desconocido');
      const found = await inspectUpload(tmp, tmpDir, maxUploadMb * 2 * 1024 * 1024);
      const fallback = original.replace(/\.(apk|apks|xapk|apkm)$/i, '');
      if (found.kind === 'split' && found.parts.length > 1) {
        // App dividida: cada parte se guarda por su SHA-256 y el registro de la app las enumera.
        const { base, parts } = found;
        for (const p of parts) {
          storeBlob(p.tmp, p.sha);
          insertFile.run(cid, p.sha, 'part', p.split || 'base', p.size, APK_MIME, p.package, p.versionCode, p.versionName, null, now());
        }
        fs.unlinkSync(tmp);
        const list = parts.map((p) => ({ sha: p.sha, split: p.split, size: p.size }));
        insertFile.run(cid, sha, 'apk', labelOf(base.manifest, fallback), parts.reduce((n, p) => n + p.size, 0), APK_MIME, base.package, base.versionCode, base.versionName, JSON.stringify(list), now());
        audit(cid, actor(req), 'archivo subido', `apk dividida ${base.package} (${parts.length} partes)`);
        return res.json({ ...presentFile(fileOf(cid, sha)), warning: found.warning });
      }
      let single = tmp, singleSha = sha, singleSize = req.file.size;
      if (found.kind === 'split') {
        // Un paquete con solo el APK base: se guarda como APK común.
        const p = found.parts[0];
        fs.unlinkSync(tmp);
        single = p.tmp; singleSha = p.sha; singleSize = p.size;
      }
      const m = await readApkManifest(single);
      if (m.split) {
        if (single !== tmp) fs.rmSync(single, { force: true });
        throw new HttpError(400, 'Es una parte suelta de una app dividida. Subí el paquete completo (.apks, .xapk o .apkm).');
      }
      storeBlob(single, singleSha);
      insertFile.run(cid, singleSha, 'apk', labelOf(m, fallback), singleSize, APK_MIME, m.package, m.versionCode || 0, String(m.versionName ?? ''), null, now());
      audit(cid, actor(req), 'archivo subido', `apk ${m.package}`);
      return res.json({ ...presentFile(fileOf(cid, singleSha)), warning: found.warning || '' });
    } catch (e) {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
      next(e instanceof BundleError ? new HttpError(400, e.message) : e);
    }
  });

  app.get('/api/files', ADMIN, (req, res) => res.json(q(`SELECT * FROM files WHERE company_id=? AND kind <> 'part' ORDER BY created_at DESC`).all(req.companyId).map(presentFile)));
  app.get('/api/files/:sha/content', STAFF, (req, res) => sendStored(res, req.companyId, req.params.sha));

  app.delete('/api/files/:sha', ADMIN, (req, res) => {
    const cid = req.companyId;
    const f = fileOf(cid, req.params.sha);
    if (!f || f.kind === 'part') throw new HttpError(404, 'Archivo inexistente');
    const used = q('SELECT name, json FROM profiles WHERE company_id=?').all(cid).find((p) => {
      const j = JSON.parse(p.json);
      return j.wallpaperSha === f.sha || j.launcherApkSha === f.sha || j.apps.some((a) => a.apkSha === f.sha);
    });
    if (used) throw new HttpError(409, `Lo usa el perfil ${used.name}`);
    q('DELETE FROM files WHERE company_id=? AND sha=?').run(cid, f.sha);
    dropBlobIfUnused(f.sha);
    // Las partes se borran salvo que otra app dividida de la empresa las comparta.
    const stillUsed = new Set(q('SELECT parts FROM files WHERE company_id=? AND parts IS NOT NULL').all(cid).flatMap((r) => JSON.parse(r.parts).map((p) => p.sha)));
    for (const p of f.parts ? JSON.parse(f.parts) : []) {
      if (stillUsed.has(p.sha)) continue;
      q(`DELETE FROM files WHERE company_id=? AND sha=? AND kind='part'`).run(cid, p.sha);
      dropBlobIfUnused(p.sha);
    }
    res.json({ ok: true });
  });

  // ---- Clientes de cada empresa ---------------------------------------------------------------
  // El ID lo carga la empresa a mano: es el mismo que usa en su sistema de gestión, para vincularlos por API.
  const EXT_ID_RE = /^[A-Za-z0-9._\/-]{1,40}$/;
  const byExtId = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  const presentClient = (c) => {
    const n = q('SELECT COUNT(*) AS n, SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) AS online, SUM(blocked) AS blocked FROM devices WHERE client_id=?').get(now() - ONLINE_MS, c.id);
    return {
      id: c.id, extId: c.ext_id, name: c.name, taxId: c.tax_id, address: c.address, phone: c.phone, email: c.email, notes: c.notes,
      createdAt: c.created_at, updatedAt: c.updated_at, devices: n.n, online: n.online || 0, blocked: n.blocked || 0,
    };
  };
  const clientData = (b) => valid(() => {
    const extId = String(b.extId ?? '').trim();
    if (!extId) throw new Error('Poné el ID del cliente');
    if (!EXT_ID_RE.test(extId)) throw new Error('El ID va de 1 a 40 caracteres: letras, números, punto, guion, guion bajo o barra');
    return {
      extId,
      name: cleanText(b.name, 120, { required: true, label: 'el nombre completo del cliente' }),
      taxId: cleanTaxId(b.taxId),
      address: cleanText(b.address, 200),
      phone: cleanPhone(b.phone),
      email: cleanEmail(b.email),
      notes: String(b.notes ?? '').slice(0, 500),
    };
  });
  const getClient = (req, id) => {
    const c = clientOf(req, id);
    if (!c) throw new HttpError(404, 'Cliente inexistente');
    return c;
  };
  const extIdTaken = (req, extId, exceptId) => {
    const r = q('SELECT id FROM clients WHERE company_id=? AND lower(ext_id)=lower(?)').get(req.companyId, extId);
    return r && r.id !== exceptId;
  };

  app.get('/api/clients', STAFF, (req, res) => {
    const list = q('SELECT * FROM clients WHERE company_id=?').all(req.companyId).map(presentClient);
    res.json(list.sort((a, b) => byExtId.compare(a.extId, b.extId)));
  });
  app.get('/api/clients/:id', STAFF, (req, res) => {
    const c = getClient(req, req.params.id);
    res.json({ ...presentClient(c), deviceList: q('SELECT * FROM devices WHERE client_id=? ORDER BY name').all(c.id).map(presentDevice) });
  });
  app.post('/api/clients', ADMIN, (req, res) => {
    const d = clientData(req.body || {});
    if (extIdTaken(req, d.extId)) throw new HttpError(409, `Ya existe un cliente con el ID ${d.extId}`);
    const id = q('INSERT INTO clients (company_id, ext_id, name, tax_id, address, phone, email, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(req.companyId, d.extId, d.name, d.taxId, d.address, d.phone, d.email, d.notes, now(), now()).lastInsertRowid;
    audit(req.companyId, actor(req), 'cliente creado', `${d.extId} ${d.name}`);
    res.json(presentClient(q('SELECT * FROM clients WHERE id=?').get(id)));
  });
  app.put('/api/clients/:id', ADMIN, (req, res) => {
    const c = getClient(req, req.params.id);
    const d = clientData(req.body || {});
    if (extIdTaken(req, d.extId, c.id)) throw new HttpError(409, `Ya existe un cliente con el ID ${d.extId}`);
    q('UPDATE clients SET ext_id=?, name=?, tax_id=?, address=?, phone=?, email=?, notes=?, updated_at=? WHERE id=?')
      .run(d.extId, d.name, d.taxId, d.address, d.phone, d.email, d.notes, now(), c.id);
    audit(req.companyId, actor(req), 'cliente modificado', `${d.extId} ${d.name}`);
    res.json(presentClient(q('SELECT * FROM clients WHERE id=?').get(c.id)));
  });
  /** Borrar un cliente no toca sus equipos: quedan sin cliente asignado. */
  app.delete('/api/clients/:id', ADMIN, (req, res) => {
    const c = getClient(req, req.params.id);
    q('UPDATE devices SET client_id=NULL WHERE client_id=?').run(c.id);
    q('UPDATE enroll_tokens SET client_id=NULL WHERE client_id=?').run(c.id);
    q('DELETE FROM clients WHERE id=?').run(c.id);
    audit(req.companyId, actor(req), 'cliente eliminado', `${c.ext_id} ${c.name}`);
    res.json({ ok: true });
  });

  // ---- Tokens de alta -----------------------------------------------------------------------
  const presentToken = (t) => {
    const c = clientRow(t.client_id);
    return { token: t.token, label: t.label, profileId: t.profile_id, group: t.grp, uses: t.uses, maxUses: t.max_uses, expiresAt: t.expires_at, createdAt: t.created_at,
      clientId: c?.id ?? null, clientName: c ? `${c.ext_id} · ${c.name}` : '' };
  };
  app.get('/api/enroll-tokens', ADMIN, (req, res) => res.json(q('SELECT * FROM enroll_tokens WHERE company_id=? ORDER BY created_at DESC').all(req.companyId).map(presentToken)));
  app.post('/api/enroll-tokens', ADMIN, (req, res) => {
    const b = req.body || {};
    const token = randomToken(12);
    const days = Math.max(0, Number(b.days) || 0);
    const profile = b.profileId && profileOf(req, b.profileId) ? b.profileId : null;
    if (b.clientId && !clientOf(req, b.clientId)) throw new HttpError(400, 'Cliente inexistente');
    q(`INSERT INTO enroll_tokens (token, company_id, label, profile_id, grp, max_uses, expires_at, created_at, client_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(token, req.companyId, String(b.label || '').slice(0, 80), profile, String(b.group || '').slice(0, 60), Math.max(0, Number(b.maxUses) || 0), days ? now() + days * DAY_MS : 0, now(), b.clientId ? Number(b.clientId) : null);
    audit(req.companyId, actor(req), 'token de alta creado', b.label || '');
    res.json(presentToken(q('SELECT * FROM enroll_tokens WHERE token=?').get(token)));
  });
  app.delete('/api/enroll-tokens/:token', ADMIN, (req, res) => {
    q('DELETE FROM enroll_tokens WHERE token=? AND company_id=?').run(req.params.token, req.companyId);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta inexistente' }));
  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Archivo rechazado: ${err.message}` });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  // ---- Tareas periódicas: conteo diario y cierre de meses; avisa a los TV Box cuando vence una gracia.
  let lastSuspended = new Set();
  const tick = () => {
    try {
      billing.tick();
      const nowSuspended = new Set(q(`SELECT * FROM companies WHERE status='suspended'`).all().filter(devicesSuspended).map((c) => c.id));
      for (const id of nowSuspended) if (!lastSuspended.has(id)) wakeCompany(id);
      lastSuspended = nowSuspended;
    } catch (e) {
      console.error('tarea periódica', e);
    }
  };
  tick();
  const timer = billingIntervalMs ? setInterval(tick, billingIntervalMs) : null;
  timer?.unref();
  const backupTimer = billingIntervalMs ? setInterval(() => backups.tick().catch((e) => console.error('respaldos', e)), 5 * 60_000) : null;
  backupTimer?.unref();

  return {
    app, db, generatedPassword, tick, billing, version: VERSION,
    backups,
    close: () => { if (timer) clearInterval(timer); if (backupTimer) clearInterval(backupTimer); db.close(); },
  };
}
