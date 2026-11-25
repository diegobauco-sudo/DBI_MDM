import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createApp } from '../src/app.js';

// Usa el código real de la versión 1.2.1, sacado del historial, para generar una base vieja con datos.
const here = path.dirname(new URL(import.meta.url).pathname);
const oldDir = path.join(here, '..', '.v121');
let hasOld = false;
try {
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.mkdirSync(oldDir);
  execSync(`git archive v1.2.1:server/src | tar -x -C "${oldDir}"`, { cwd: path.join(here, '..', '..'), stdio: 'pipe' });
  hasOld = fs.existsSync(path.join(oldDir, 'app.js'));
} catch { hasOld = false; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-mig-'));
const old = {};

async function serve(createFn, opts) {
  const ctx = createFn({ dataDir: dir, longPollMs: 200, ...opts });
  const srv = await new Promise((ok) => { const s = ctx.app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const stop = () => { srv.closeAllConnections(); srv.close(); ctx.close(); };
  return { base, call, stop, getCookie: () => cookie };
}

after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(oldDir, { recursive: true, force: true }); });

test('una base de la v1.2.1 con datos se migra sin perder nada', { skip: !hasOld && 'sin acceso a la etiqueta v1.2.1' }, async () => {
  const { createApp: createOld } = await import(path.join(oldDir, 'app.js'));
  const v1 = await serve(createOld, { adminPassword: 'clave-vieja-123' });
  await v1.call('POST', '/api/login', { username: 'admin', password: 'clave-vieja-123' });
  const profile = (await v1.call('GET', '/api/profiles')).body[0];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');
  const form = new FormData();
  form.set('kind', 'image');
  form.set('file', new Blob([png]), 'fondo.png');
  const img = await (await fetch(`${v1.base}/api/files`, { method: 'POST', headers: { cookie: v1.getCookie(), 'x-wifly': '1' }, body: form })).json();
  await v1.call('PUT', `/api/profiles/${profile.id}`, { ...profile, title: 'Hotel Viejo', wallpaperSha: img.sha, exitUser: 'tecnico', exitPassword: 'salida-1234', apps: [{ package: 'com.netflix.ninja' }] });
  const tok = (await v1.call('POST', '/api/enroll-tokens', { label: 'lote viejo', group: 'Planta baja' })).body.token;
  const e = await (await fetch(`${v1.base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok, installId: 'equipo-viejo-01', model: 'Q5' }) })).json();
  Object.assign(old, { deviceToken: e.deviceToken, deviceId: e.deviceId, sha: img.sha, tok });
  await v1.call('POST', '/api/devices/bulk', { ids: [e.deviceId], action: 'message', payload: { body: 'pendiente de entrega' } });
  const cfgBefore = await (await fetch(`${v1.base}/api/device/config`, { headers: { authorization: `Bearer ${e.deviceToken}` } })).json();
  v1.stop();

  const v2 = await serve(createApp, {});
  const dev = (url) => fetch(v2.base + url, { headers: { authorization: `Bearer ${old.deviceToken}` } });

  // El equipo sigue conectado con su token de siempre y conserva su configuración.
  const cfg = await (await dev('/api/device/config')).json();
  assert.equal(cfg.title, 'Hotel Viejo');
  assert.deepEqual(cfg.apps.map((a) => a.package), ['com.netflix.ninja']);
  assert.equal(cfg.wallpaper.sha, old.sha);
  assert.equal(cfg.exit.hash, cfgBefore.exit.hash, 'la clave de salida no cambia');
  assert.equal((await dev(`/api/device/files/${old.sha}`)).status, 200, 'el fondo sigue disponible para el equipo');
  const poll = await (await dev(`/api/device/poll?cv=${cfg.version}`)).json();
  assert.equal(poll.commands[0].payload.body, 'pendiente de entrega', 'los mensajes pendientes se entregan igual');

  // El administrador de siempre entra con su clave y ahora es administrador general.
  assert.equal((await v2.call('POST', '/api/login', { username: 'admin', password: 'clave-vieja-123' })).status, 200);
  const me = (await v2.call('GET', '/api/me')).body;
  assert.equal(me.role, 'superadmin');
  const companies = (await v2.call('GET', '/api/companies')).body;
  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, 'Empresa principal');
  assert.equal(companies[0].devices, 1);
  assert.equal(companies[0].monthDevices, 1, 'el equipo ya cuenta para la facturación del mes');

  await v2.call('POST', '/api/context', { companyId: companies[0].id });
  const devices = (await v2.call('GET', '/api/devices')).body;
  assert.equal(devices[0].group, 'Planta baja');
  assert.equal((await v2.call('GET', '/api/enroll-tokens')).body[0].label, 'lote viejo');
  assert.equal((await v2.call('GET', '/api/files')).body[0].name, 'fondo.png');
  const audit = (await v2.call('GET', '/api/audit')).body;
  assert.ok(audit.some((a) => a.action === 'mensaje'), 'la actividad vieja se conserva');

  // El token viejo sigue sirviendo para sumar equipos a la empresa principal.
  const e2 = await fetch(`${v2.base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: old.tok, installId: 'equipo-nuevo-02', model: 'Q5' }) });
  assert.equal(e2.status, 200);
  v2.stop();

  // Abrirla otra vez no vuelve a migrar ni duplica nada.
  const v3 = await serve(createApp, {});
  await v3.call('POST', '/api/login', { username: 'admin', password: 'clave-vieja-123' });
  assert.equal((await v3.call('GET', '/api/companies')).body[0].devices, 2);
  v3.stop();
});

test('una instalación nueva arranca sin empresas', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-new-'));
  const ctx = createApp({ dataDir: fresh, adminPassword: 'clave-nueva-123', billingIntervalMs: 0 });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 0);
  assert.equal(ctx.db.prepare(`SELECT role FROM users`).get().role, 'superadmin');
  assert.equal(ctx.db.prepare('PRAGMA user_version').get().user_version, 3);
  ctx.close();
  fs.rmSync(fresh, { recursive: true, force: true });
});
