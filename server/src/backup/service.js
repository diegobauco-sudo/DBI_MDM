import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptFile, decryptFile } from './crypto.js';
import { buildGeneral, buildCompany, extract } from './archive.js';
import { stageGeneralRestore, restoreCompany } from './restore.js';
import { makeDestination, applyRetention, BACKUP_RE, DEST_TYPES, GOOGLE, GOOGLE_SCOPES, googleExchangeCode } from './destinations.js';

const DEFAULT_CONFIG = { enabled: false, frequency: 'daily', weekday: 1, hour: 3, keep: 7, password: '', destinations: [] };
/** Campos secretos de cada tipo de destino: se guardan pero nunca vuelven al panel. */
const SECRETS = { sftp: ['password', 'privateKey'], ftps: ['password'], gdrive: ['refreshToken'] };
const FIELDS = {
  sftp: ['host', 'port', 'username', 'password', 'privateKey', 'dir', 'fingerprint'],
  ftps: ['host', 'port', 'username', 'password', 'dir', 'allowSelfSigned'],
  gdrive: [],
};

export class BackupError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createBackups({ db, dataDir, filesDir, tmpDir, version, now, timezone, getSetting, onCompanyRestored, onGeneralRestore, log = console.error }) {
  const q = (sql) => db.prepare(sql);
  const running = new Set();
  const oauthStates = new Map();

  const keyFor = (companyId) => (companyId ? `company:${companyId}` : 'general');
  const companyOf = (key) => (key.startsWith('company:') ? Number(key.slice(8)) : null);
  const prefixFor = (key) => (companyOf(key) ? `wifly-empresa-${companyOf(key)}-` : 'wifly-general-');

  function local(ts = now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: parts.minute, weekday };
  }

  function getConfig(key) {
    const row = q('SELECT json FROM backup_configs WHERE key=?').get(key);
    return { ...DEFAULT_CONFIG, ...(row ? JSON.parse(row.json) : {}) };
  }
  const putConfig = (key, cfg) => q(`INSERT INTO backup_configs (key, json, updated_at) VALUES (?,?,?)
      ON CONFLICT (key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`).run(key, JSON.stringify(cfg), now());

  /** Lo que ve el panel: sin contraseñas ni permisos de Google. */
  function present(key) {
    const c = getConfig(key);
    const destinations = c.destinations.map((d) => {
      const config = { ...d.config };
      for (const s of SECRETS[d.type] || []) {
        config[`${s}Set`] = !!config[s];
        delete config[s];
      }
      return { id: d.id, type: d.type, typeLabel: DEST_TYPES[d.type], name: d.name, config, lastResult: d.lastResult || null };
    });
    const runs = q('SELECT * FROM backup_runs WHERE key=? ORDER BY id DESC LIMIT 25').all(key).map((r) => ({
      id: r.id, trigger: r.trigger, actor: r.actor, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
      size: r.size, filename: r.filename, results: JSON.parse(r.detail || '[]'), error: r.error,
    }));
    const g = { clientId: getSetting('googleClientId'), clientSecret: getSetting('googleClientSecret') };
    return {
      key, enabled: c.enabled, frequency: c.frequency, weekday: c.weekday, hour: c.hour, keep: c.keep, passwordSet: !!c.password,
      destinations, runs, running: running.has(key), googleReady: !!(g.clientId && g.clientSecret), lastRunDay: c.lastRunDay || null,
    };
  }

  function cleanDestination(input, previous) {
    const type = input.type;
    if (!DEST_TYPES[type]) throw new BackupError('Tipo de destino inválido');
    const name = String(input.name || DEST_TYPES[type]).trim().slice(0, 60);
    const config = {};
    const prevCfg = previous?.type === type ? previous.config : {};
    for (const f of FIELDS[type]) {
      let v = input.config?.[f];
      if ((SECRETS[type] || []).includes(f) && (v === undefined || v === '')) v = prevCfg[f];
      if (f === 'fingerprint' && input.config?.resetFingerprint) v = '';
      else if (f === 'fingerprint') v = prevCfg.fingerprint || '';
      if (f === 'allowSelfSigned') v = v === true;
      else if (f === 'port') v = Number(v) || (type === 'sftp' ? 22 : 21);
      else if (typeof v === 'string') v = v.trim();
      if (v !== undefined && v !== '') config[f] = v;
    }
    if (type === 'gdrive') {
      config.refreshToken = prevCfg.refreshToken;
      config.email = prevCfg.email;
    } else {
      if (!config.host || !/^[A-Za-z0-9.-]+$/.test(config.host)) throw new BackupError('Indicá el servidor (nombre o IP)');
      if (!config.username) throw new BackupError('Indicá el usuario');
      if (!config.password && !config.privateKey) throw new BackupError('Indicá la contraseña');
    }
    return { id: previous?.id || crypto.randomUUID(), type, name, config, lastResult: previous?.lastResult || null };
  }

  function save(key, body) {
    const prev = getConfig(key);
    const freq = ['daily', 'weekly', 'manual'].includes(body.frequency) ? body.frequency : 'daily';
    const keep = Number(body.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new BackupError('Las copias a guardar van de 1 a 365');
    const hour = Number(body.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new BackupError('Hora inválida');
    let password = prev.password;
    if (body.password) {
      if (String(body.password).length < 10) throw new BackupError('La contraseña de cifrado necesita 10 caracteres o más');
      password = String(body.password);
    }
    const destinations = (Array.isArray(body.destinations) ? body.destinations : []).slice(0, 10)
      .map((d) => cleanDestination(d, prev.destinations.find((p) => p.id === d.id)));
    if (body.enabled && !password) throw new BackupError('Definí la contraseña de cifrado antes de activar los respaldos');
    putConfig(key, { ...prev, enabled: !!body.enabled, frequency: freq, weekday: Math.max(0, Math.min(6, Number(body.weekday) || 0)), hour, keep, password, destinations });
    return present(key);
  }

  const ctxFor = (key, destId) => ({
    google: { clientId: getSetting('googleClientId'), clientSecret: getSetting('googleClientSecret') },
    folderName: companyOf(key) ? `WiFly MDM - respaldos empresa ${companyOf(key)}` : 'WiFly MDM - respaldos generales',
    onFingerprint: (fp) => {
      const c = getConfig(key);
      const d = c.destinations.find((x) => x.id === destId);
      if (d) { d.config.fingerprint = fp; putConfig(key, c); }
    },
  });
  const destOf = (key, destId) => {
    const d = getConfig(key).destinations.find((x) => x.id === destId);
    if (!d) throw new BackupError('Destino inexistente', 404);
    return { d, dest: makeDestination(d, ctxFor(key, d.id)) };
  };
  const setResult = (key, destId, result) => {
    const c = getConfig(key);
    const d = c.destinations.find((x) => x.id === destId);
    if (d) { d.lastResult = { ...result, at: now() }; putConfig(key, c); }
  };

  async function test(key, destId) {
    const { dest } = destOf(key, destId);
    try {
      await dest.test();
      setResult(key, destId, { ok: true, message: 'Conexión correcta' });
      return { ok: true };
    } catch (e) {
      setResult(key, destId, { ok: false, message: e.message });
      throw new BackupError(e.message, 502);
    }
  }

  // ---- Ejecutar un respaldo -----------------------------------------------------------------
  async function execute(key, runId) {
    const cfg = getConfig(key);
    const tmp = [];
    const results = [];
    let status = 'error', size = null, filename = null, error = null;
    try {
      if (!cfg.password) throw new Error('Falta la contraseña de cifrado');
      if (!cfg.destinations.length) throw new Error('No hay destinos configurados');
      const cid = companyOf(key);
      const plain = cid
        ? await buildCompany({ db, filesDir, tmpDir, version, companyId: cid })
        : await buildGeneral({ db, filesDir, tmpDir, version });
      tmp.push(plain);
      const l = local();
      filename = `${prefixFor(key)}${l.day}_${String(l.hour).padStart(2, '0')}${l.minute}.wfbk`;
      const enc = path.join(tmpDir, `${crypto.randomUUID()}.wfbk`);
      tmp.push(enc);
      await encryptFile(plain, enc, cfg.password);
      fs.rmSync(plain, { force: true });
      size = fs.statSync(enc).size;
      for (const d of cfg.destinations) {
        const r = { destId: d.id, name: d.name, type: d.type, ok: false, deleted: [] };
        try {
          const dest = makeDestination(d, ctxFor(key, d.id));
          await dest.upload(enc, filename);
          r.ok = true;
          r.deleted = await applyRetention(dest, prefixFor(key), cfg.keep).catch((e) => { r.warning = `No se pudieron borrar copias viejas: ${e.message}`; return []; });
        } catch (e) {
          r.error = e.message;
        }
        setResult(key, d.id, { ok: r.ok, message: r.ok ? `Respaldo subido: ${filename}` : r.error });
        results.push(r);
      }
      const ok = results.filter((r) => r.ok).length;
      status = ok === results.length ? 'ok' : ok ? 'partial' : 'error';
      if (!ok) error = 'No se pudo subir a ningún destino';
    } catch (e) {
      error = e.message;
      log('respaldo', key, e);
    } finally {
      for (const f of tmp) fs.rmSync(f, { force: true });
      q('UPDATE backup_runs SET status=?, finished_at=?, size=?, filename=?, detail=?, error=? WHERE id=?')
        .run(status, now(), size, filename, JSON.stringify(results), error, runId);
      running.delete(key);
    }
    return status;
  }

  /** Arranca un respaldo y devuelve enseguida; el panel sigue el progreso en el historial. */
  function start(key, trigger, actor) {
    if (running.has(key)) throw new BackupError('Ya hay un respaldo en curso', 409);
    const cfg = getConfig(key);
    if (!cfg.password) throw new BackupError('Definí la contraseña de cifrado antes de respaldar');
    if (!cfg.destinations.length) throw new BackupError('Agregá al menos un destino');
    running.add(key);
    const id = q(`INSERT INTO backup_runs (key, trigger, actor, status, started_at) VALUES (?,?,?,'running',?)`).run(key, trigger, actor || '', now()).lastInsertRowid;
    const done = execute(key, id);
    return { id, done };
  }

  /** Respaldos programados que tocan ahora. Se llama cada pocos minutos. */
  async function tick() {
    const l = local();
    for (const row of q('SELECT key, json FROM backup_configs').all()) {
      const c = { ...DEFAULT_CONFIG, ...JSON.parse(row.json) };
      if (!c.enabled || c.frequency === 'manual' || !c.password || !c.destinations.length) continue;
      if (c.lastRunDay === l.day || l.hour < c.hour) continue;
      if (c.frequency === 'weekly' && l.weekday !== c.weekday) continue;
      if (companyOf(row.key) && !q('SELECT 1 FROM companies WHERE id=?').get(companyOf(row.key))) continue;
      putConfig(row.key, { ...c, lastRunDay: l.day });
      try {
        await start(row.key, 'programado', 'sistema').done;
      } catch (e) {
        log('respaldo programado', row.key, e);
      }
    }
  }

  // ---- Listar, descargar y restaurar ---------------------------------------------------------
  async function remote(key) {
    const cfg = getConfig(key);
    const prefix = prefixFor(key);
    const out = [];
    for (const d of cfg.destinations) {
      try {
        const items = (await makeDestination(d, ctxFor(key, d.id)).list()).filter((e) => e.name.startsWith(prefix)).sort((a, b) => b.name.localeCompare(a.name));
        out.push({ destId: d.id, name: d.name, type: d.type, items });
      } catch (e) {
        out.push({ destId: d.id, name: d.name, type: d.type, items: [], error: e.message });
      }
    }
    return out;
  }

  function checkName(key, name) {
    if (!BACKUP_RE.test(name || '') || !name.startsWith(prefixFor(key))) throw new BackupError('Nombre de respaldo inválido');
  }

  async function download(key, destId, name) {
    checkName(key, name);
    const { dest } = destOf(key, destId);
    const file = path.join(tmpDir, `${crypto.randomUUID()}.wfbk`);
    try {
      await dest.download(name, file);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw new BackupError(e.message, 502);
    }
    return file;
  }

  /** Restaura desde un archivo cifrado local (descargado de un destino o subido desde la PC). */
  async function restoreFile(key, encFile, password) {
    if (running.has(key)) throw new BackupError('Hay un respaldo en curso. Esperá a que termine.', 409);
    const plain = path.join(tmpDir, `${crypto.randomUUID()}.tar.gz`);
    let extracted = null;
    try {
      await decryptFile(encFile, plain, password).catch((e) => { throw new BackupError(e.message); });
      extracted = await extract(plain, tmpDir).catch((e) => { throw new BackupError(e.message); });
      const cid = companyOf(key);
      if (cid) {
        const r = (() => {
          try {
            return restoreCompany({ db, filesDir, extracted, companyId: cid });
          } catch (e) {
            throw new BackupError(e.message);
          }
        })();
        onCompanyRestored?.(cid);
        return { kind: 'company', ...r, createdAt: extracted.manifest.createdAt };
      }
      try {
        stageGeneralRestore(dataDir, extracted);
      } catch (e) {
        throw new BackupError(e.message);
      }
      extracted = null;
      onGeneralRestore?.();
      return { kind: 'general', restart: true };
    } finally {
      fs.rmSync(plain, { force: true });
      if (extracted) fs.rmSync(extracted.dir, { recursive: true, force: true });
    }
  }

  async function restoreRemote(key, destId, name, password) {
    const file = await download(key, destId, name);
    try {
      return await restoreFile(key, file, password);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // ---- Conexión con Google Drive ----------------------------------------------------------------
  function googleStart(key, destId, redirectUri) {
    const clientId = getSetting('googleClientId');
    if (!clientId || !getSetting('googleClientSecret')) throw new BackupError('El administrador general tiene que configurar la aplicación de Google en Configuración');
    const { d } = destOf(key, destId);
    if (d.type !== 'gdrive') throw new BackupError('Ese destino no es Google Drive');
    for (const [s, v] of oauthStates) if (v.exp < now()) oauthStates.delete(s);
    const state = crypto.randomBytes(24).toString('base64url');
    oauthStates.set(state, { key, destId, redirectUri, exp: now() + 15 * 60_000 });
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    });
    return `${GOOGLE.auth}?${params}`;
  }

  /** Google vuelve a esta dirección: la cookie de sesión no viaja, así que el "state" identifica el pedido. */
  async function googleCallback(state, code) {
    const s = oauthStates.get(state);
    oauthStates.delete(state);
    if (!s || s.exp < now()) throw new BackupError('El enlace de Google venció. Volvé a tocar "Conectar con Google".');
    const t = await googleExchangeCode({ clientId: getSetting('googleClientId'), clientSecret: getSetting('googleClientSecret'), code, redirectUri: s.redirectUri })
      .catch((e) => { throw new BackupError(e.message, 502); });
    const c = getConfig(s.key);
    const d = c.destinations.find((x) => x.id === s.destId);
    if (!d) throw new BackupError('El destino ya no existe');
    d.config = { ...d.config, refreshToken: t.refreshToken, email: t.email };
    d.lastResult = { ok: true, message: `Conectado como ${t.email || 'cuenta de Google'}`, at: now() };
    putConfig(s.key, c);
    return { key: s.key, email: t.email };
  }

  function forgetCompany(companyId) {
    q('DELETE FROM backup_configs WHERE key=?').run(keyFor(companyId));
  }

  return { keyFor, present, save, test, start, tick, remote, download, restoreFile, restoreRemote, googleStart, googleCallback, forgetCompany, prefixFor };
}
