import express from 'express';
import crypto from 'node:crypto';

/** Google simulado: OAuth y la parte de Drive que usa WiFly (carpetas, subida reanudable, listar, bajar, borrar). */
export function fakeGoogle() {
  const app = express();
  const files = new Map();
  const sessions = new Map();
  const tokens = new Set();
  let failUploads = false;
  const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
  const authed = (req, res, next) => (tokens.has((req.get('authorization') || '').slice(7)) ? next() : res.status(401).json({ error: { message: 'token inválido' } }));

  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body;
    if (b.client_secret !== 'secreto-google') return res.status(401).json({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      if (b.code !== 'codigo-bueno') return res.status(400).json({ error: 'invalid_grant' });
      return res.json({ access_token: 'a', refresh_token: 'permiso-permanente', id_token: idToken('diego@ejemplo.com'), expires_in: 3600 });
    }
    if (b.grant_type === 'refresh_token' && b.refresh_token === 'permiso-permanente') {
      const t = crypto.randomUUID();
      tokens.add(t);
      return res.json({ access_token: t, expires_in: 3600 });
    }
    res.status(400).json({ error: 'invalid_grant' });
  });

  const matches = (f, q) => {
    if (f.trashed) return false;
    const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    if (q.includes("mimeType='application/vnd.google-apps.folder'") && f.mimeType !== 'application/vnd.google-apps.folder') return false;
    if (name && f.name !== name.replace(/\\'/g, "'")) return false;
    if (parent && !(f.parents || []).includes(parent)) return false;
    return true;
  };
  app.get('/drive/v3/files', authed, (req, res) => res.json({ files: [...files.values()].filter((f) => matches(f, String(req.query.q || ''))).map(({ content, ...f }) => ({ ...f, size: String(content?.length || 0) })) }));
  const create = (meta, content) => {
    const id = crypto.randomUUID();
    files.set(id, { id, name: meta.name, parents: meta.parents || [], mimeType: meta.mimeType || 'application/octet-stream', content, createdTime: new Date().toISOString() });
    return id;
  };
  app.post('/drive/v3/files', authed, express.json(), (req, res) => res.json({ id: create(req.body, Buffer.alloc(0)) }));
  app.post('/upload/drive/v3/files', authed, express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
    if (req.query.uploadType === 'resumable') {
      if (failUploads) return res.status(403).json({ error: { message: 'storageQuotaExceeded' } });
      const meta = JSON.parse(req.body.toString() || '{}');
      const sid = crypto.randomUUID();
      sessions.set(sid, { meta, size: Number(req.get('x-upload-content-length')), parts: [] });
      return res.set('location', `${req.protocol}://${req.get('host')}/sesion/${sid}`).json({});
    }
    const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(req.body.toString())[1]);
    res.json({ id: create(meta, Buffer.from('ok')) });
  });
  app.put('/sesion/:sid', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
    const s = sessions.get(req.params.sid);
    s.parts.push(req.body);
    const got = s.parts.reduce((n, b) => n + b.length, 0);
    if (got < s.size) return res.status(308).end();
    res.json({ id: create(s.meta, Buffer.concat(s.parts)) });
  });
  app.get('/drive/v3/files/:id', authed, (req, res) => {
    const f = files.get(req.params.id);
    if (!f) return res.status(404).json({ error: { message: 'no existe' } });
    res.end(f.content);
  });
  app.delete('/drive/v3/files/:id', authed, (req, res) => { files.delete(req.params.id); res.status(204).end(); });
  return { app, files, setFailUploads: (v) => { failUploads = v; }, backups: () => [...files.values()].filter((f) => f.name.endsWith('.wfbk')) };
}
