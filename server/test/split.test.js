import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-split-'));
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
let base, srv, ctx, cookie = '', deviceToken, deviceId;

const admin = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const dev = async (method, url) => {
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${deviceToken}` } });
  return r;
};
async function upload(name) {
  const form = new FormData();
  form.set('kind', 'apk');
  form.set('file', new Blob([fs.readFileSync(path.join(fixtures, name))]), name);
  const r = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'x-wifly': '1' }, body: form });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  ctx = createApp({ dataDir: dir, adminPassword: 'clave-de-prueba-1', longPollMs: 500 });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
  await admin('POST', '/api/login', { username: 'admin', password: 'clave-de-prueba-1' });
  const token = (await admin('POST', '/api/enroll-tokens', {})).body.token;
  const e = await fetch(`${base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, installId: 'splitdevice1' }) });
  ({ deviceToken, deviceId } = await e.json());
});
after(() => { srv.closeAllConnections(); srv.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let bundleSha;

test('un .apks de bundletool se guarda como app dividida con sus partes', async () => {
  const r = await upload('demo.apks');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.package, 'com.example.tvapp');
  assert.equal(r.body.versionCode, 7);
  assert.equal(r.body.parts, 4, 'base y tres partes; los standalones se ignoran');
  assert.equal(r.body.name, 'Demo TV');
  bundleSha = r.body.sha;
  const lib = (await admin('GET', '/api/files')).body;
  assert.equal(lib.length, 1, 'las partes no aparecen sueltas en la biblioteca');
});

test('el perfil entrega las partes al equipo y cada una se descarga íntegra', async () => {
  const p = (await admin('GET', '/api/profiles')).body[0];
  await admin('PUT', `/api/profiles/${p.id}`, { ...p, apps: [{ package: 'com.example.tvapp', apkSha: bundleSha }] });
  const cfg = await (await dev('GET', '/api/device/config')).json();
  const apk = cfg.apps[0].apk;
  assert.equal(apk.versionCode, 7);
  assert.deepEqual(apk.parts.map((x) => x.split), ['', 'config.arm64_v8a', 'config.armeabi_v7a', 'config.xhdpi'], 'la base va primero');
  for (const part of apk.parts) {
    const r = await dev('GET', `/api/device/files/${part.sha}`);
    assert.equal(r.status, 200);
    const got = Buffer.from(await r.arrayBuffer());
    assert.equal(got.length, part.size);
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), part.sha);
  }
});

test('la orden de instalar desde el panel también lleva las partes', async () => {
  await admin('POST', '/api/devices/bulk', { ids: [deviceId], action: 'install', payload: { sha: bundleSha } });
  const poll = await (await dev('GET', '/api/device/poll?cv=x')).json();
  const cmd = poll.commands.find((c) => c.type === 'install');
  assert.equal(cmd.payload.parts.length, 4);
});

test('un .xapk con OBB se acepta con aviso', async () => {
  const r = await upload('demo.xapk');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.parts, 2);
  assert.match(r.body.warning, /OBB/);
});

test('un paquete con solo la base queda como APK común', async () => {
  const r = await upload('solo-base.apks');
  assert.equal(r.status, 200);
  assert.equal(r.body.parts, 0);
});

test('paquetes inconsistentes y partes sueltas se rechazan con un motivo claro', async () => {
  for (const [name, re] of [['mezcla.apks', /apps distintas/], ['versiones.apks', /otra versión/], ['sin-base.apks', /no tiene el APK base/], ['parte-suelta.apk', /parte suelta/]]) {
    const r = await upload(name);
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, re, name);
  }
});

test('borrar la app dividida borra sus partes salvo las compartidas', async () => {
  const p = (await admin('GET', '/api/profiles')).body[0];
  assert.equal((await admin('DELETE', `/api/files/${bundleSha}`)).status, 409, 'no se borra si un perfil la usa');
  await admin('PUT', `/api/profiles/${p.id}`, { ...p, apps: [] });
  const cfg = await (await dev('GET', '/api/device/config')).json();
  const before = fs.readdirSync(path.join(dir, 'files')).length;
  assert.equal((await admin('DELETE', `/api/files/${bundleSha}`)).status, 200);
  const after = fs.readdirSync(path.join(dir, 'files')).length;
  // demo.xapk comparte la base y la parte armeabi_v7a con demo.apks; solo se van arm64 y xhdpi.
  assert.equal(before - after, 2);
  assert.equal(cfg.apps.length, 0);
});
