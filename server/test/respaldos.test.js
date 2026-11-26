import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fakeGoogle } from './google-falso.js';
import { empresa, usuario } from './datos.js';

// SFTP y FTPS reales si hay servidores de prueba levantados (ver test/README); si no, esas partes se saltan.
const portOpen = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); ok(true); }).on('error', () => ok(false)); });
const SFTP = { type: 'sftp', name: 'NAS por SFTP', config: { host: '127.0.0.1', port: 2222, username: 'bkuser', password: 'Clave-Prueba-123', dir: `wifly-test-${process.pid}` } };
const FTPS = { type: 'ftps', name: 'Hosting por FTPS', config: { host: '127.0.0.1', port: 2121, username: 'bkuser', password: 'Clave-Prueba-123', dir: `wifly-ftps-${process.pid}`, allowSelfSigned: true } };

let fakeNow = Date.parse('2026-11-25T12:00:00Z');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-bk-'));
let base, srv, ctx, gsrv, google, restarts = 0, createApp;
// Se detectan antes de declarar las pruebas, para que la decisión de saltarlas use el valor real.
const hasSftp = await portOpen(2222);
const hasFtps = await portOpen(2121);

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
  };
  return { call, cookie: () => cookie, login: (u, p) => call('POST', '/api/login', { username: u, password: p }) };
}
const dev = async (token, url) => (await fetch(base + url, { headers: { authorization: `Bearer ${token}` } })).json();
async function waitRun(c, scope) {
  for (let i = 0; i < 200; i++) {
    const s = (await c.call('GET', `/api/backups/${scope}`)).body;
    if (!s.running && s.runs[0] && s.runs[0].status !== 'running') return s.runs[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el respaldo no terminó');
}

async function start() {
  ctx = createApp({ dataDir: dir, adminPassword: 'super-clave-123', clock: () => fakeNow, billingIntervalMs: 0, publicUrl: 'https://mdm.ejemplo.com', onRestart: () => { restarts++; } });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
}
const stop = () => { srv.closeAllConnections(); srv.close(); ctx.close(); };

before(async () => {
  google = fakeGoogle();
  await new Promise((ok) => { gsrv = google.app.listen(0, ok); });
  const g = `http://127.0.0.1:${gsrv.address().port}`;
  Object.assign(process.env, { WIFLY_GOOGLE_AUTH_URL: `${g}/auth`, WIFLY_GOOGLE_TOKEN_URL: `${g}/token`, WIFLY_GOOGLE_API_URL: g });
  ({ createApp } = await import('../src/app.js'));
  await start();
});
after(() => { stop(); gsrv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const sup = client();
const adm = client();
const op = client();
let A, B, devA, driveId;

test('preparación: dos empresas con equipos', async () => {
  await sup.login('admin', 'super-clave-123');
  A = (await sup.call('POST', '/api/companies', empresa('Hotel Sur', 'admin.sur', 'Clave-sur-123'))).body.id;
  B = (await sup.call('POST', '/api/companies', empresa('Bar Centro', 'admin.bar', 'Clave-bar-123'))).body.id;
  await adm.login('admin.sur', 'Clave-sur-123');
  await adm.call('POST', '/api/users', { ...usuario('op.sur', 'Clave-op-1234'), role: 'operator' });
  await op.login('op.sur', 'Clave-op-1234');
  const tok = (await adm.call('POST', '/api/enroll-tokens', { label: 'lote' })).body.token;
  const e = await (await fetch(`${base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok, installId: 'equipo-sur-0001', model: 'Q5' }) })).json();
  devA = e;
  const prof = (await adm.call('GET', '/api/profiles')).body[0];
  await adm.call('PUT', `/api/profiles/${prof.id}`, { ...prof, title: 'Hotel Sur original', apps: [{ package: 'com.netflix.ninja' }] });
});

test('permisos: el general solo para el administrador general; los operadores no ven respaldos', async () => {
  assert.equal((await adm.call('GET', '/api/backups/general')).status, 403);
  assert.equal((await op.call('GET', '/api/backups/empresa')).status, 403);
  assert.equal((await adm.call('GET', '/api/backups/empresa')).status, 200);
  assert.equal((await sup.call('GET', '/api/backups/empresa')).status, 409, 'el general tiene que elegir empresa');
  assert.equal((await sup.call('GET', '/api/backups/general')).status, 200);
});

test('configurar: contraseñas y permisos nunca vuelven al panel', async () => {
  const bad = await sup.call('PUT', '/api/backups/general', { enabled: true, frequency: 'daily', hour: 3, keep: 2, destinations: [] });
  assert.equal(bad.status, 400, 'sin contraseña de cifrado no se activa');
  const dests = [{ type: 'gdrive', name: 'Drive de Diego' }];
  if (hasSftp) dests.push(SFTP);
  if (hasFtps) dests.push(FTPS);
  const r = await sup.call('PUT', '/api/backups/general', { enabled: true, frequency: 'daily', hour: 3, keep: 2, password: 'cifrado-general-1', destinations: dests });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('cifrado-general-1') && !text.includes('Clave-Prueba-123'), 'no se filtran contraseñas');
  assert.equal(r.body.passwordSet, true);
  if (hasSftp) assert.equal(r.body.destinations.find((d) => d.type === 'sftp').config.passwordSet, true);
  driveId = r.body.destinations.find((d) => d.type === 'gdrive').id;
  // Guardar de nuevo sin escribir las claves las conserva.
  const again = await sup.call('PUT', '/api/backups/general', { ...r.body, password: '', destinations: r.body.destinations.map((d) => ({ id: d.id, type: d.type, name: d.name, config: { ...d.config } })) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.passwordSet, true);
});

test('Google Drive: sin aplicación configurada avisa; con ella, se conecta por OAuth', async () => {
  const before = await sup.call('GET', `/api/backups/general/google/start/${driveId}`);
  assert.equal(before.status, 400);
  assert.match(before.body.error, /aplicación de Google/);
  await sup.call('PUT', '/api/settings', { brandPhrase: '', graceDays: 7, googleClientId: 'cliente.apps.googleusercontent.com', googleClientSecret: 'secreto-google' });
  const s = (await sup.call('GET', '/api/settings')).body;
  assert.equal(s.googleSecretSet, true);
  assert.equal(s.googleClientSecret, undefined, 'el secreto no vuelve');
  assert.equal(s.googleRedirectUri, 'https://mdm.ejemplo.com/api/backups/google/callback');
  const url = new URL((await sup.call('GET', `/api/backups/general/google/start/${driveId}`)).body.url);
  assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file', 'solo los archivos que crea WiFly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const state = url.searchParams.get('state');
  const forged = await sup.call('GET', `/api/backups/google/callback?state=inventado&code=codigo-bueno`);
  assert.match(decodeURIComponent(forged.headers.get('location')), /venció/);
  const ok = await fetch(`${base}/api/backups/google/callback?state=${state}&code=codigo-bueno`, { redirect: 'manual' });
  assert.match(decodeURIComponent(ok.headers.get('location')), /backups-google=ok.*diego@ejemplo\.com/);
  const reuse = await fetch(`${base}/api/backups/google/callback?state=${state}&code=codigo-bueno`, { redirect: 'manual' });
  assert.match(decodeURIComponent(reuse.headers.get('location')), /error/, 'el enlace sirve una sola vez');
  const cfg = (await sup.call('GET', '/api/backups/general')).body;
  const d = cfg.destinations.find((x) => x.id === driveId);
  assert.equal(d.config.email, 'diego@ejemplo.com');
  assert.equal(d.config.refreshTokenSet, true);
  assert.equal(JSON.stringify(cfg).includes('permiso-permanente'), false);
  assert.equal((await sup.call('POST', `/api/backups/general/test/${driveId}`)).status, 200);
});

test('probar destinos reales SFTP y FTPS', { skip: !hasSftp && !hasFtps && 'sin servidores de prueba' }, async () => {
  const cfg = (await sup.call('GET', '/api/backups/general')).body;
  for (const d of cfg.destinations.filter((x) => x.type !== 'gdrive')) {
    const r = await sup.call('POST', `/api/backups/general/test/${d.id}`);
    assert.equal(r.status, 200, `${d.type}: ${JSON.stringify(r.body)}`);
  }
  const sftp = (await sup.call('GET', '/api/backups/general')).body.destinations.find((x) => x.type === 'sftp');
  if (sftp) assert.match(sftp.config.fingerprint, /^SHA256:/, 'guarda la huella del servidor');
});

test('respaldo general manual: sube cifrado a todos los destinos y respeta las copias a guardar', async () => {
  for (let i = 0; i < 3; i++) {
    fakeNow += 60_000 * 7;
    const r = await sup.call('POST', '/api/backups/general/run');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const run = await waitRun(sup, 'general');
    assert.equal(run.status, 'ok', JSON.stringify(run));
  }
  const s = (await sup.call('GET', '/api/backups/general')).body;
  assert.equal(s.runs.length, 3);
  assert.match(s.runs[0].filename, /^wifly-general-2026-11-25_\d{4}\.wfbk$/);
  assert.equal(google.backups().length, 2, 'con 2 copias a guardar, borra la más vieja');
  const content = google.backups()[0].content;
  assert.equal(content.subarray(0, 8).toString(), 'WFLYBK01');
  assert.ok(!content.includes(Buffer.from('Hotel Sur')), 'el contenido va cifrado');
  const remote = (await sup.call('GET', '/api/backups/general/remote')).body;
  for (const d of remote) assert.equal(d.items.length, 2, `${d.type}: ${JSON.stringify(d)}`);
});

test('un destino que falla no frena a los demás', async () => {
  google.setFailUploads(true);
  fakeNow += 60_000 * 7;
  await sup.call('POST', '/api/backups/general/run');
  const run = await waitRun(sup, 'general');
  google.setFailUploads(false);
  if (hasSftp || hasFtps) {
    assert.equal(run.status, 'partial');
    assert.match(run.results.find((r) => r.type === 'gdrive').error, /storageQuotaExceeded/);
  } else {
    assert.equal(run.status, 'error');
  }
});

let companyBackup;
test('respaldo de empresa: lo hace su administrador, con su propia contraseña y destino', async () => {
  const r = await adm.call('PUT', '/api/backups/empresa', { enabled: false, frequency: 'manual', hour: 0, keep: 5, password: 'cifrado-sur-123', destinations: [{ type: 'gdrive', name: 'Drive del hotel' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const did = r.body.destinations[0].id;
  const url = new URL((await adm.call('GET', `/api/backups/empresa/google/start/${did}`)).body.url);
  await fetch(`${base}/api/backups/google/callback?state=${url.searchParams.get('state')}&code=codigo-bueno`, { redirect: 'manual' });
  fakeNow += 60_000 * 7;
  assert.equal((await adm.call('POST', '/api/backups/empresa/run')).status, 200);
  const run = await waitRun(adm, 'empresa');
  assert.equal(run.status, 'ok', JSON.stringify(run));
  assert.match(run.filename, new RegExp(`^wifly-empresa-${A}-`));
  companyBackup = { destId: did, name: run.filename };
  const remote = (await adm.call('GET', '/api/backups/empresa/remote')).body;
  assert.deepEqual(remote[0].items.map((i) => i.name), [run.filename], 'la empresa solo ve sus respaldos, no los generales');
});

test('restaurar una empresa: vuelve a como estaba sin tocar a la otra', async () => {
  // Cambios después del respaldo: se borra el equipo y se cambia el perfil.
  const prof = (await adm.call('GET', '/api/profiles')).body[0];
  await adm.call('PUT', `/api/profiles/${prof.id}`, { ...prof, title: 'título cambiado', apps: [] });
  await adm.call('DELETE', `/api/devices/${devA.deviceId}`);
  await sup.call('POST', '/api/context', { companyId: B });
  await sup.call('POST', '/api/enroll-tokens', { label: 'de B' });
  const tokensB = (await sup.call('GET', '/api/enroll-tokens')).body.length;

  const wrong = await adm.call('POST', '/api/backups/empresa/restore', { ...companyBackup, password: 'otra-clave-xx' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Contraseña incorrecta/);

  const r = await adm.call('POST', '/api/backups/empresa/restore', { ...companyBackup, password: 'cifrado-sur-123' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.devices, 1);
  assert.deepEqual(r.body.skipped, []);

  // El administrador se recrea en la restauración: vuelve a entrar con su misma clave.
  await adm.login('admin.sur', 'Clave-sur-123');
  const p = (await adm.call('GET', '/api/profiles')).body[0];
  assert.equal(p.title, 'Hotel Sur original');
  assert.equal((await adm.call('GET', '/api/devices')).body.length, 1);
  assert.equal((await dev(devA.deviceToken, '/api/device/config')).title, 'Hotel Sur original', 'el equipo vuelve a funcionar con su token');
  assert.equal((await sup.call('GET', '/api/enroll-tokens')).body.length, tokensB, 'la otra empresa no cambió');
});

test('un respaldo de una empresa no se puede restaurar en otra', async () => {
  const c = client();
  await c.login('admin.bar', 'Clave-bar-123');
  await c.call('PUT', '/api/backups/empresa', { frequency: 'manual', hour: 0, keep: 5, password: 'cifrado-bar-123', destinations: [] });
  // Bar Centro sube el archivo de Hotel Sur desde la PC.
  const file = path.join(dir, 'ajeno.wfbk');
  const dl = await fetch(`${base}/api/backups/empresa/download/${companyBackup.destId}/${companyBackup.name}`, { headers: { cookie: adm.cookie() } });
  assert.equal(dl.status, 200);
  fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
  const form = new FormData();
  form.set('password', 'cifrado-sur-123');
  form.set('file', new Blob([fs.readFileSync(file)]), 'ajeno.wfbk');
  const r = await fetch(`${base}/api/backups/empresa/restore-file`, { method: 'POST', headers: { cookie: c.cookie(), 'x-wifly': '1' }, body: form });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /otra empresa/);
  // Un archivo alterado tampoco pasa.
  const bytes = fs.readFileSync(file);
  bytes[200] ^= 0xff;
  const f2 = new FormData();
  f2.set('password', 'cifrado-sur-123');
  f2.set('file', new Blob([bytes]), 'alterado.wfbk');
  const r2 = await fetch(`${base}/api/backups/empresa/restore-file`, { method: 'POST', headers: { cookie: adm.cookie(), 'x-wifly': '1' }, body: f2 });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /dañado/);
});

test('programado: corre una vez por día después de la hora elegida', async () => {
  const c = (await adm.call('GET', '/api/backups/empresa')).body;
  await adm.call('PUT', '/api/backups/empresa', { ...c, enabled: true, frequency: 'daily', hour: 22, password: '', destinations: c.destinations });
  const count = () => ctx.db.prepare(`SELECT COUNT(*) AS n FROM backup_runs WHERE key='company:${A}' AND trigger='programado'`).get().n;
  fakeNow = Date.parse('2026-11-26T20:00:00Z'); // 17:00 en Argentina: todavía no
  await ctx.backups.tick();
  assert.equal(count(), 0);
  fakeNow = Date.parse('2026-11-27T01:30:00Z'); // 22:30 del 26 en Argentina
  await ctx.backups.tick();
  assert.equal(count(), 1);
  fakeNow += 30 * 60_000;
  await ctx.backups.tick();
  assert.equal(count(), 1, 'no repite el mismo día');
});

test('restaurar el sistema completo: se aplica al reiniciar y deja copia del estado anterior', async () => {
  await sup.login('admin', 'super-clave-123'); // el salto de reloj anterior venció la sesión
  const remote = (await sup.call('GET', '/api/backups/general/remote')).body.find((d) => d.type === 'gdrive');
  const name = remote.items[0].name;
  // Después del respaldo: una empresa nueva que el respaldo no tiene.
  await sup.call('POST', '/api/companies', empresa('Empresa posterior'));
  const r = await sup.call('POST', '/api/backups/general/restore', { destId: remote.destId, name, password: 'cifrado-general-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restart, true);
  assert.equal(restarts, 1, 'pide reiniciar el servidor');
  stop();
  const { applyPendingRestore } = await import('../src/backup/restore.js');
  assert.equal(applyPendingRestore(dir, () => {}), true);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('pre-restore-')), 'guarda el estado anterior');
  await start();
  await sup.login('admin', 'super-clave-123');
  const names = (await sup.call('GET', '/api/companies')).body.map((c) => c.name);
  assert.ok(names.includes('Hotel Sur'));
  assert.ok(!names.includes('Empresa posterior'), 'volvió al momento del respaldo');
  assert.equal((await dev(devA.deviceToken, '/api/device/config')).title, 'Hotel Sur original');
});

test('SFTP rechaza un servidor con otra huella (posible suplantación)', { skip: !hasSftp && 'sin servidor SFTP' }, async () => {
  await sup.login('admin', 'super-clave-123');
  const row = ctx.db.prepare(`SELECT json FROM backup_configs WHERE key='general'`).get();
  const cfg = JSON.parse(row.json);
  const sftp = cfg.destinations.find((d) => d.type === 'sftp');
  sftp.config.fingerprint = 'SHA256:huellaDeOtroServidorQueNoEsElNuestro0000000';
  ctx.db.prepare(`UPDATE backup_configs SET json=? WHERE key='general'`).run(JSON.stringify(cfg));
  const r = await sup.call('POST', `/api/backups/general/test/${sftp.id}`);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /huella del servidor SFTP cambió/);
});
