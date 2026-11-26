import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { empresa, usuario } from './datos.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-'));
let base, srv, ctx, cookie = '';
const apkPath = process.env.WIFLY_APK || path.resolve('../android/build/WiFlyLauncher.apk');

async function admin(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function dev(token, method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  ctx = createApp({ dataDir: dir, adminPassword: 'Clave-de-prueba-1', longPollMs: 1500 });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let token, deviceId, deviceToken, profileId, version;

test('el panel exige sesión y rechaza claves incorrectas', async () => {
  assert.equal((await admin('GET', '/api/devices')).status, 401);
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'mal' })).status, 401);
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'Clave-de-prueba-1' })).status, 200);
  assert.equal((await admin('GET', '/api/devices')).status, 409, 'el administrador general tiene que elegir una empresa');
  const c = await admin('POST', '/api/companies', empresa('Hotel Sur'));
  assert.equal(c.status, 200);
  await admin('POST', '/api/context', { companyId: c.body.id });
  assert.equal((await admin('GET', '/api/devices')).status, 200);
});

test('una petición sin el encabezado del panel se rechaza aun con sesión', async () => {
  const r = await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"name":"x"}' });
  assert.equal(r.status, 403);
});

test('alta de equipo con token', async () => {
  const profiles = (await admin('GET', '/api/profiles')).body;
  profileId = profiles[0].id;
  token = (await admin('POST', '/api/enroll-tokens', { label: 'Lote 1', profileId, group: 'Hotel', maxUses: 2 })).body.token;
  assert.equal((await dev('', 'POST', '/api/device/enroll', { token: 'falso', installId: 'abcdefgh12' })).status, 403);
  const e = await dev('', 'POST', '/api/device/enroll', { token, installId: 'abcdefgh12', model: 'X96 Max', sdk: 28 });
  assert.equal(e.status, 200);
  ({ deviceId, deviceToken } = e.body);
  const list = (await admin('GET', '/api/devices')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].group, 'Hotel');
});

test('reenrolar el mismo equipo no lo duplica y revoca el token viejo', async () => {
  const e = await dev('', 'POST', '/api/device/enroll', { token, installId: 'abcdefgh12', model: 'X96 Max' });
  assert.equal(e.body.deviceId, deviceId);
  assert.equal((await dev(deviceToken, 'GET', '/api/device/config')).status, 401);
  deviceToken = e.body.deviceToken;
});

test('el token de alta respeta el máximo de usos', async () => {
  assert.equal((await dev('', 'POST', '/api/device/enroll', { token, installId: 'otroequipo99' })).status, 403);
});

test('un token de equipo no sirve en el panel, ni falta de token en la API de equipos', async () => {
  assert.equal((await dev(deviceToken, 'GET', '/api/devices')).status, 401);
  assert.equal((await dev('nada', 'GET', '/api/device/poll')).status, 401);
});

test('la clave de salida se guarda hasheada y nunca vuelve al panel', async () => {
  const r = await admin('PUT', `/api/profiles/${profileId}`, {
    name: 'General', title: 'Hotel Sur', exitUser: 'tecnico', exitPassword: 'salida-segura',
    apps: [{ package: 'com.netflix.ninja', label: 'Netflix' }, { package: 'mal paquete' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.hasExit, true);
  assert.equal(JSON.stringify(r.body).includes('salida-segura'), false);
  assert.equal(r.body.apps.length, 1);
  const cfg = (await dev(deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(JSON.stringify(cfg).includes('salida-segura'), false);
  const expected = crypto.pbkdf2Sync('salida-segura', Buffer.from(cfg.exit.salt, 'hex'), cfg.exit.iter, 32, 'sha256').toString('hex');
  assert.equal(cfg.exit.hash, expected);
  assert.deepEqual(cfg.apps.map((a) => a.package), ['com.netflix.ninja']);
  version = cfg.version;
});

test('el long poll espera y el mensaje llega al instante a varios equipos', async () => {
  const e2 = await dev('', 'POST', '/api/device/enroll', { token: (await admin('POST', '/api/enroll-tokens', {})).body.token, installId: 'segundoequipo' });
  const t2 = e2.body.deviceToken;
  const v2 = (await dev(t2, 'GET', '/api/device/config')).body.version;
  const started = Date.now();
  const p1 = dev(deviceToken, 'GET', `/api/device/poll?cv=${version}`);
  const p2 = dev(t2, 'GET', `/api/device/poll?cv=${v2}`);
  await new Promise((r) => setTimeout(r, 200));
  const send = await admin('POST', '/api/devices/bulk', { ids: [deviceId, e2.body.deviceId], action: 'message', payload: { title: 'Aviso', body: 'Mantenimiento hoy', mode: 'banner', seconds: 20 } });
  assert.equal(send.body.count, 2);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(Date.now() - started < 1200, 'tiene que despertar antes del timeout');
  assert.equal(r1.body.commands[0].type, 'message');
  assert.equal(r2.body.commands[0].payload.body, 'Mantenimiento hoy');
  const res = await dev(deviceToken, 'POST', `/api/device/commands/${r1.body.commands[0].id}/result`, { ok: true, detail: 'mostrado' });
  assert.equal(res.status, 200);
  const sends = (await admin('GET', '/api/sends')).body;
  assert.deepEqual(sends[0].items.map((i) => i.status).sort(), ['done', 'sent']);
});

test('un comando para un equipo apagado espera a que vuelva y no se entrega dos veces', async () => {
  await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'reboot' });
  const a = await dev(deviceToken, 'GET', `/api/device/poll?cv=${version}`);
  assert.equal(a.body.commands[0].type, 'reboot');
  const b = await dev(deviceToken, 'GET', `/api/device/poll?cv=${version}`);
  assert.equal(b.body.commands.length, 0);
});

test('bloquear y desbloquear cambia la configuración y despierta al equipo', async () => {
  const wait = dev(deviceToken, 'GET', `/api/device/poll?cv=${version}`);
  await new Promise((r) => setTimeout(r, 100));
  await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'lock', payload: { title: 'Servicio suspendido', message: 'Llamá al 123' } });
  const r = await wait;
  assert.notEqual(r.body.configVersion, version);
  let cfg = (await dev(deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.blocked, true);
  assert.equal(cfg.blockMessage, 'Llamá al 123');
  await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'unlock' });
  cfg = (await dev(deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.blocked, false);
  assert.equal(cfg.version, version, 'desbloquear vuelve exactamente a la configuración anterior');
});

test('las excepciones por equipo agregan y quitan apps', async () => {
  await admin('PATCH', `/api/devices/${deviceId}`, { overrides: { add: ['com.google.android.youtube.tv'], remove: ['com.netflix.ninja'] } });
  const cfg = (await dev(deviceToken, 'GET', '/api/device/config')).body;
  assert.deepEqual(cfg.apps.map((a) => a.package), ['com.google.android.youtube.tv']);
  await admin('PATCH', `/api/devices/${deviceId}`, { overrides: { add: [], remove: [] } });
});

test('el estado informado aparece en el panel y alimenta las apps conocidas', async () => {
  await dev(deviceToken, 'POST', '/api/device/state', { deviceOwner: true, kiosk: true, lockTask: true, appliedConfig: version, apps: [{ package: 'com.netflix.ninja', label: 'Netflix' }, { package: 'com.droidlogic.mboxlauncher', label: 'Launcher', home: true }] });
  const d = (await admin('GET', `/api/devices/${deviceId}`)).body;
  assert.equal(d.state.lockTask, true);
  assert.equal(d.synced, true);
  assert.equal(d.online, true);
  assert.deepEqual((await admin('GET', '/api/known-apps')).body.map((k) => k.package), ['com.netflix.ninja'], 'el launcher original no se ofrece');
});

async function upload(kind, name, buffer) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', new Blob([buffer]), name);
  const r = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'x-wifly': '1' }, body: form });
  return { status: r.status, body: await r.json() };
}

test('la imagen se valida por contenido y llega al equipo como fondo', async () => {
  assert.equal((await upload('image', 'trucho.jpg', Buffer.from('<script>alert(1)</script>'))).status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');
  const up = await upload('image', 'fondo.png', png);
  assert.equal(up.status, 200);
  const p = (await admin('GET', '/api/profiles')).body[0];
  await admin('PUT', `/api/profiles/${profileId}`, { ...p, wallpaperSha: up.body.sha });
  const cfg = (await dev(deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.wallpaper.sha, up.body.sha);
  assert.equal(cfg.exit.user, 'tecnico', 'guardar el perfil sin clave conserva las credenciales');
  const f = await fetch(`${base}/api/device/files/${up.body.sha}`, { headers: { authorization: `Bearer ${deviceToken}` } });
  const got = Buffer.from(await f.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), up.body.sha);
  assert.equal((await fetch(`${base}/api/device/files/${up.body.sha}`)).status, 401);
  assert.equal((await admin('DELETE', `/api/files/${up.body.sha}`)).status, 409, 'no se puede borrar un fondo en uso');
});

test('el APK real de WiFly se lee bien y un APK falso se rechaza', { skip: !fs.existsSync(apkPath) }, async () => {
  assert.equal((await upload('apk', 'falso.apk', Buffer.from('no soy un apk'))).status, 400);
  const up = await upload('apk', 'WiFlyLauncher.apk', fs.readFileSync(apkPath));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.package, 'com.wifly.launcher');
  assert.ok(up.body.versionCode >= 1);
  assert.match(up.body.versionName, /^1\./);
});

test('comandos inválidos se rechazan', async () => {
  assert.equal((await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'message', payload: { body: '  ' } })).status, 400);
  assert.equal((await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'formatear' })).status, 400);
  assert.equal((await admin('POST', '/api/devices/bulk', { ids: [], action: 'sync' })).status, 400);
});

test('equipo eliminado deja de autenticarse', async () => {
  await admin('DELETE', `/api/devices/${deviceId}`);
  assert.equal((await dev(deviceToken, 'GET', '/api/device/config')).status, 401);
});

test('el límite de intentos de login corta la fuerza bruta', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await admin('POST', '/api/login', { username: 'admin', password: 'mal' });
  assert.equal(last.status, 429);
});
