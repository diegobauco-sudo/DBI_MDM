import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import SftpClient from 'ssh2-sftp-client';
import * as ftp from 'basic-ftp';

/**
 * Cada destino ofrece la misma interfaz:
 *   test()                      prueba la conexión escribiendo y borrando un archivo chico
 *   upload(localPath, name)     sube un respaldo
 *   list()                      [{ name, size, date }] de los respaldos de WiFly en el destino
 *   download(name, localPath)
 *   remove(name)
 * Los errores se devuelven con un texto entendible para el panel.
 */

export const BACKUP_RE = /^wifly-[a-z0-9-]+-\d{4}-\d{2}-\d{2}_\d{4}\.wfbk$/;
const plainError = (prefix, e) => new Error(`${prefix}: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200)}`);
const remoteDir = (d) => (d || '').trim().replace(/\/+$/, '') || '.';

// ---- SFTP -----------------------------------------------------------------------------------

function sftpDestination(cfg, { onFingerprint }) {
  const dir = remoteDir(cfg.dir);
  async function connect() {
    const c = new SftpClient();
    let seen = null;
    try {
      await c.connect({
        host: cfg.host, port: Number(cfg.port) || 22, username: cfg.username, readyTimeout: 20000,
        ...(cfg.privateKey ? { privateKey: cfg.privateKey } : { password: cfg.password }),
        // La primera conexión guarda la huella del servidor; después solo acepta esa misma.
        hostVerifier: (key) => {
          seen = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          return !cfg.fingerprint || cfg.fingerprint === seen;
        },
      });
    } catch (e) {
      if (cfg.fingerprint && seen && seen !== cfg.fingerprint) {
        throw new Error(`La huella del servidor SFTP cambió (antes ${cfg.fingerprint}, ahora ${seen}). Si cambiaste de servidor a propósito, borrá la huella en el destino y probá de nuevo.`);
      }
      throw plainError('No se pudo conectar por SFTP', e);
    }
    if (!cfg.fingerprint && seen) onFingerprint?.(seen);
    return c;
  }
  const withClient = async (fn) => {
    const c = await connect();
    try {
      return await fn(c);
    } catch (e) {
      throw plainError('SFTP', e);
    } finally {
      await c.end().catch(() => {});
    }
  };
  const remote = (name) => (dir === '.' ? name : `${dir}/${name}`);
  return {
    test: () => withClient(async (c) => {
      if (dir !== '.') await c.mkdir(dir, true);
      const probe = remote(`.wifly-prueba-${Date.now()}`);
      await c.put(Buffer.from('ok'), probe);
      await c.delete(probe);
    }),
    upload: (local, name) => withClient(async (c) => {
      if (dir !== '.') await c.mkdir(dir, true);
      const part = remote(`${name}.parcial`);
      await c.fastPut(local, part);
      await c.rename(part, remote(name));
    }),
    list: () => withClient(async (c) => {
      if (!(await c.exists(dir))) return [];
      return (await c.list(dir)).filter((e) => e.type === '-' && BACKUP_RE.test(e.name)).map((e) => ({ name: e.name, size: e.size, date: e.modifyTime }));
    }),
    download: (name, local) => withClient((c) => c.fastGet(remote(name), local)),
    remove: (name) => withClient((c) => c.delete(remote(name))),
  };
}

// ---- FTPS (FTP sobre TLS explícito) ----------------------------------------------------------

function ftpsDestination(cfg) {
  const dir = remoteDir(cfg.dir);
  const withClient = async (fn) => {
    const c = new ftp.Client(30000);
    try {
      await c.access({
        host: cfg.host, port: Number(cfg.port) || 21, user: cfg.username, password: cfg.password,
        secure: true, secureOptions: { rejectUnauthorized: !cfg.allowSelfSigned, ...(net.isIP(cfg.host) ? {} : { servername: cfg.host }) },
      });
      if (dir !== '.') await c.ensureDir(dir);
      return await fn(c);
    } catch (e) {
      const m = String(e?.message || e);
      if (/self[- ]signed|unable to verify|certificate/i.test(m)) throw new Error('El servidor FTPS usa un certificado propio. Si confiás en él, marcá "Aceptar certificado propio" en el destino.');
      throw plainError('FTPS', e);
    } finally {
      c.close();
    }
  };
  return {
    test: () => withClient(async (c) => {
      const probe = `.wifly-prueba-${Date.now()}`;
      await c.uploadFrom(Readable.from([Buffer.from('ok')]), probe);
      await c.remove(probe);
    }),
    upload: (local, name) => withClient(async (c) => {
      await c.uploadFrom(local, `${name}.parcial`);
      await c.rename(`${name}.parcial`, name);
    }),
    list: () => withClient(async (c) => (await c.list()).filter((e) => e.isFile && BACKUP_RE.test(e.name))
      .map((e) => ({ name: e.name, size: e.size, date: e.modifiedAt ? e.modifiedAt.getTime() : null }))),
    download: (name, local) => withClient((c) => c.downloadTo(local, name)),
    remove: (name) => withClient((c) => c.remove(name)),
  };
}

// ---- Google Drive -----------------------------------------------------------------------------

/** Direcciones de Google; las pruebas las reemplazan por un servidor simulado. */
export const GOOGLE = {
  auth: process.env.WIFLY_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.WIFLY_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  api: process.env.WIFLY_GOOGLE_API_URL || 'https://www.googleapis.com',
};
/** drive.file: WiFly solo ve y toca los archivos que crea él mismo, nunca el resto del Drive. */
export const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const CHUNK = 8 * 1024 * 1024;

async function googleJson(res, what) {
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* sin cuerpo JSON */ }
  if (!res.ok) {
    const reason = body.error_description || body.error?.message || (typeof body.error === 'string' ? body.error : '') || `HTTP ${res.status}`;
    if (body.error === 'invalid_grant') throw new Error('Google revocó el permiso o venció. Volvé a tocar "Conectar con Google".');
    throw new Error(`Google Drive (${what}): ${reason}`);
  }
  return body;
}

export async function googleExchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(GOOGLE.token, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const t = await googleJson(res, 'autorización');
  if (!t.refresh_token) throw new Error('Google no entregó un permiso permanente. Quitá el acceso de WiFly en tu cuenta de Google y conectá de nuevo.');
  let email = '';
  try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch { /* sin correo */ }
  return { refreshToken: t.refresh_token, email };
}

function driveDestination(cfg, { google, folderName }) {
  let cached = null;
  async function token() {
    if (!google?.clientId || !google?.clientSecret) throw new Error('Falta configurar la aplicación de Google en Configuración (administrador general).');
    if (!cfg.refreshToken) throw new Error('Este destino todavía no está conectado. Tocá "Conectar con Google".');
    if (cached && cached.exp > Date.now() + 60000) return cached.value;
    const res = await fetch(GOOGLE.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: google.clientId, client_secret: google.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
    });
    const t = await googleJson(res, 'permiso');
    cached = { value: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
    return cached.value;
  }
  const api = async (method, url, { json, headers = {}, body } = {}) => fetch(url.startsWith('http') ? url : `${GOOGLE.api}${url}`, {
    method, headers: { authorization: `Bearer ${await token()}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function folderId() {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${q(folderName)}' and trashed=false`;
    const found = await googleJson(await api('GET', `/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&spaces=drive`), 'buscar carpeta');
    if (found.files?.length) return found.files[0].id;
    const created = await googleJson(await api('POST', '/drive/v3/files?fields=id', { json: { name: folderName, mimeType: 'application/vnd.google-apps.folder' } }), 'crear carpeta');
    return created.id;
  }
  async function find(name) {
    const folder = await folderId();
    const query = `'${folder}' in parents and name='${q(name)}' and trashed=false`;
    const r = await googleJson(await api('GET', `/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`), 'buscar archivo');
    if (!r.files?.length) throw new Error(`No está en Google Drive: ${name}`);
    return r.files[0].id;
  }
  /** Subida reanudable en partes de 8 MB: sirve para respaldos grandes. */
  async function upload(local, name) {
    const folder = await folderId();
    const size = fs.statSync(local).size;
    const start = await api('POST', '/upload/drive/v3/files?uploadType=resumable', {
      json: { name, parents: [folder] }, headers: { 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(size) },
    });
    if (!start.ok) await googleJson(start, 'iniciar subida');
    const session = start.headers.get('location');
    const fd = fs.openSync(local, 'r');
    try {
      let offset = 0;
      do {
        const len = Math.min(CHUNK, size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const res = await fetch(session, {
          method: 'PUT', body: buf,
          headers: { 'content-length': String(len), 'content-range': size ? `bytes ${offset}-${offset + len - 1}/${size}` : 'bytes */0' },
        });
        if (res.status === 308) { offset += len; continue; }
        await googleJson(res, 'subir');
        offset += len;
      } while (offset < size);
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    test: async () => {
      const folder = await folderId();
      const f = await googleJson(await api('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id', {
        headers: { 'content-type': 'multipart/related; boundary=wfly' },
        body: `--wfly\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: '.wifly-prueba', parents: [folder] })}\r\n--wfly\r\ncontent-type: text/plain\r\n\r\nok\r\n--wfly--`,
      }), 'prueba');
      await api('DELETE', `/drive/v3/files/${f.id}`);
    },
    upload,
    list: async () => {
      const folder = await folderId();
      const out = [];
      let pageToken = '';
      do {
        const query = `'${folder}' in parents and trashed=false`;
        const r = await googleJson(await api('GET', `/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,size,createdTime)&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`), 'listar');
        for (const f of r.files || []) if (BACKUP_RE.test(f.name)) out.push({ name: f.name, size: Number(f.size || 0), date: Date.parse(f.createdTime) || null });
        pageToken = r.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    download: async (name, local) => {
      const res = await api('GET', `/drive/v3/files/${await find(name)}?alt=media`);
      if (!res.ok) await googleJson(res, 'descargar');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(local));
    },
    remove: async (name) => {
      const res = await api('DELETE', `/drive/v3/files/${await find(name)}`);
      if (!res.ok && res.status !== 404) await googleJson(res, 'borrar');
    },
  };
}

export const DEST_TYPES = { sftp: 'SFTP', ftps: 'FTPS', gdrive: 'Google Drive' };

export function makeDestination(dest, ctx) {
  if (dest.type === 'sftp') return sftpDestination(dest.config, ctx);
  if (dest.type === 'ftps') return ftpsDestination(dest.config);
  if (dest.type === 'gdrive') return driveDestination(dest.config, ctx);
  throw new Error(`Tipo de destino desconocido: ${dest.type}`);
}

/** Borra los respaldos más viejos del alcance hasta dejar "keep". El nombre lleva la fecha, así que ordena solo. */
export async function applyRetention(destination, prefix, keep) {
  const mine = (await destination.list()).filter((e) => e.name.startsWith(prefix)).sort((a, b) => b.name.localeCompare(a.name));
  const extra = mine.slice(Math.max(1, keep));
  for (const e of extra) await destination.remove(e.name);
  return extra.map((e) => e.name);
}

export const _test = { remoteDir, path };
