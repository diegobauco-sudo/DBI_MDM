import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { empresa, usuario } from './datos.js';

// Reloj controlable para probar cierres de mes y días de gracia.
let fakeNow = Date.parse('2026-10-15T15:00:00Z');
const clock = () => fakeNow;
const DAY = 86400_000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-multi-'));
let base, srv, ctx;

/** Un cliente con su propia cookie, para simular varios usuarios a la vez. */
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    // Bytes crudos: r.text() descartaría la marca BOM que necesita Excel.
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: r.status, body: json, text };
  };
  return { call, login: (username, password) => call('POST', '/api/login', { username, password }) };
}
const dev = async (token, method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function enroll(enrollToken, installId, model = 'Q5') {
  const r = await fetch(`${base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: enrollToken, installId, model }) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  ctx = createApp({ dataDir: dir, adminPassword: 'super-clave-123', longPollMs: 300, clock, billingIntervalMs: 0 });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const sup = client();
const adminA = client();
const adminB = client();
const opA = client();
let A, B, tokA, tokB, devA, devB;

test('el administrador general crea empresas con su administrador', async () => {
  assert.equal((await sup.login('admin', 'super-clave-123')).status, 200);
  const a = await sup.call('POST', '/api/companies', empresa('Hotel Sur', 'admin.sur', 'Clave-sur-123'));
  const b = await sup.call('POST', '/api/companies', empresa('Bar Centro', 'admin.bar', 'Clave-bar-123'));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  A = a.body.id; B = b.body.id;
  assert.deepEqual(a.body.admins, ['admin.sur']);
  assert.equal((await sup.call('POST', '/api/companies', { name: 'Hotel Sur' })).status, 409, 'nombre repetido');
  assert.equal((await sup.call('POST', '/api/companies', empresa('X', 'admin.sur', 'Clave-x-1234'))).status, 409, 'usuario repetido');
  assert.equal((await sup.call('GET', '/api/companies')).body.length, 2, 'la empresa con usuario repetido no quedó a medias');
});

test('cada administrador de empresa entra directo a su empresa', async () => {
  assert.equal((await adminA.login('admin.sur', 'Clave-sur-123')).status, 200);
  assert.equal((await adminB.login('admin.bar', 'Clave-bar-123')).status, 200);
  const me = (await adminA.call('GET', '/api/me')).body;
  assert.equal(me.role, 'admin');
  assert.equal(me.company.name, 'Hotel Sur');
  tokA = (await adminA.call('POST', '/api/enroll-tokens', { label: 'lote A' })).body.token;
  tokB = (await adminB.call('POST', '/api/enroll-tokens', { label: 'lote B' })).body.token;
  devA = (await enroll(tokA, 'equipo-a-0001')).body;
  devB = (await enroll(tokB, 'equipo-b-0001')).body;
  await enroll(tokB, 'equipo-b-0002');
  assert.equal((await adminA.call('GET', '/api/devices')).body.length, 1);
  assert.equal((await adminB.call('GET', '/api/devices')).body.length, 2);
});

test('una empresa no puede ver ni tocar nada de otra', async () => {
  assert.equal((await adminA.call('GET', `/api/devices/${devB.deviceId}`)).status, 404);
  assert.equal((await adminA.call('PATCH', `/api/devices/${devB.deviceId}`, { name: 'robado' })).status, 404);
  assert.equal((await adminA.call('DELETE', `/api/devices/${devB.deviceId}`)).status, 404);
  const bulk = await adminA.call('POST', '/api/devices/bulk', { ids: [devB.deviceId], action: 'lock' });
  assert.equal(bulk.status, 404);
  const profB = (await adminB.call('GET', '/api/profiles')).body[0];
  assert.equal((await adminA.call('PUT', `/api/profiles/${profB.id}`, { name: 'x' })).status, 404);
  assert.equal((await adminA.call('POST', '/api/devices/bulk', { ids: [devA.deviceId], action: 'assignProfile', payload: { profileId: profB.id } })).status, 400);
  assert.equal((await adminA.call('DELETE', `/api/enroll-tokens/${tokB}`)).status, 200);
  assert.equal((await enroll(tokB, 'equipo-b-0003')).status, 200, 'el token de B sigue vivo: A no pudo borrarlo');
  assert.equal((await adminA.call('GET', '/api/companies')).status, 403);
  assert.equal((await adminA.call('GET', '/api/billing')).status, 403);
  assert.equal((await adminA.call('POST', '/api/context', { companyId: B })).status, 403);
});

test('el mismo archivo subido por dos empresas queda separado', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');
  // Subida con cookies tomadas de un login nuevo de cada administrador.
  const loginCookie = async (u, p) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const ca = await loginCookie('admin.sur', 'Clave-sur-123');
  const cb = await loginCookie('admin.bar', 'Clave-bar-123');
  const post = async (cookie, name) => {
    const form = new FormData();
    form.set('kind', 'image');
    form.set('file', new Blob([png]), name);
    const r = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'x-wifly': '1' }, body: form });
    return r.json();
  };
  const fa = await post(ca, 'fondo-a.png');
  const fb = await post(cb, 'fondo-b.png');
  assert.equal(fa.sha, fb.sha);
  assert.equal((await adminA.call('GET', '/api/files')).body[0].name, 'fondo-a.png');
  assert.equal((await adminB.call('GET', '/api/files')).body[0].name, 'fondo-b.png');
  const blob = path.join(dir, 'files', fa.sha);
  assert.ok(fs.existsSync(blob));
  assert.equal((await adminA.call('DELETE', `/api/files/${fa.sha}`)).status, 200);
  assert.ok(fs.existsSync(blob), 'B todavía lo usa');
  assert.equal((await dev(devB.deviceToken, 'GET', `/api/device/files/${fa.sha}`)).status, 200);
  assert.equal((await dev(devA.deviceToken, 'GET', `/api/device/files/${fa.sha}`)).status, 404, 'A ya no lo tiene');
  assert.equal((await adminB.call('DELETE', `/api/files/${fa.sha}`)).status, 200);
  assert.ok(!fs.existsSync(blob), 'nadie lo usa: se borra del disco');
});

test('el operador de la empresa manda mensajes, bloquea y desbloquea, sin borrar ni tocar perfiles', async () => {
  assert.equal((await adminA.call('POST', '/api/users', { ...usuario('op.sur', 'Clave-op-123'), role: 'operator' })).status, 200);
  const otro = await adminA.call('POST', '/api/users', { ...usuario('otro.admin', 'Clave-ad-123'), role: 'admin' });
  assert.equal(otro.status, 200, 'el administrador de la empresa crea otros administradores');
  assert.equal((await adminA.call('DELETE', `/api/users/${otro.body.id}`)).status, 200);
  assert.equal((await adminA.call('POST', '/api/users', { ...usuario('nuevo.super', 'Clave-su-123'), role: 'superadmin' })).status, 403);
  assert.equal((await opA.login('op.sur', 'Clave-op-123')).status, 200);
  assert.equal((await opA.call('GET', '/api/devices')).status, 200);
  for (const action of ['message', 'lock', 'unlock']) {
    const r = await opA.call('POST', '/api/devices/bulk', { ids: [devA.deviceId], action, payload: { body: 'Hola' } });
    assert.equal(r.status, 200, action);
  }
  for (const action of ['reboot', 'uninstall', 'assignProfile', 'decommission']) {
    assert.equal((await opA.call('POST', '/api/devices/bulk', { ids: [devA.deviceId], action, payload: {} })).status, 403, action);
  }
  for (const [m, u] of [['PUT', '/api/profiles/1'], ['POST', '/api/profiles'], ['DELETE', `/api/devices/${devA.deviceId}`], ['GET', '/api/known-apps'], ['GET', '/api/users'], ['GET', '/api/audit']]) {
    assert.equal((await opA.call(m, u, m === 'GET' ? undefined : {})).status, 403, `${m} ${u}`);
  }
  const users = (await adminA.call('GET', '/api/users')).body;
  assert.deepEqual(users.map((u) => u.username).sort(), ['admin.sur', 'op.sur']);
  assert.equal((await adminB.call('DELETE', `/api/users/${users.find((u) => u.username === 'op.sur').id}`)).status, 403, 'B no borra usuarios de A');
});

test('el administrador general administra una empresa eligiéndola', async () => {
  assert.equal((await sup.call('GET', '/api/devices')).status, 409);
  await sup.call('POST', '/api/context', { companyId: B });
  assert.equal((await sup.call('GET', '/api/devices')).body.length, 3);
  assert.equal((await sup.call('POST', '/api/users', { ...usuario('admin2.bar', 'Clave-ad2-123'), role: 'admin' })).status, 200);
  await sup.call('POST', '/api/context', { companyId: null });
  assert.deepEqual((await sup.call('GET', '/api/users?scope=system')).body.map((u) => u.username), ['admin'], 'los usuarios del sistema');
  assert.equal((await sup.call('GET', '/api/users')).status, 409, 'sin empresa elegida no hay usuarios de empresa');
});

test('la marca: nombre de la empresa y frase fija llegan al TV Box', async () => {
  assert.equal((await sup.call('PUT', '/api/settings', { brandPhrase: 'por DBI', graceDays: 5 })).status, 200);
  const cfg = (await dev(devA.deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.title, 'Hotel Sur', 'sin título en el perfil se muestra el nombre de la empresa');
  assert.equal(cfg.brandPhrase, 'por DBI');
  await sup.call('PATCH', `/api/companies/${A}`, { name: 'Hotel Sur Mendoza' });
  assert.equal((await dev(devA.deviceToken, 'GET', '/api/device/config')).body.title, 'Hotel Sur Mendoza');
  assert.equal((await adminA.call('GET', '/api/me')).body.brandPhrase, 'por DBI');
});

test('suspender: el panel se corta ya y los TV Box al vencer la gracia; pagar reactiva todo', async () => {
  const v0 = (await dev(devA.deviceToken, 'GET', '/api/device/config')).body.version;
  const s = await sup.call('POST', `/api/companies/${A}/suspend`);
  assert.equal(s.body.status, 'suspended');
  assert.equal(s.body.devicesSuspended, false);
  assert.equal((await adminA.call('GET', '/api/devices')).status, 401, 'sus sesiones abiertas se cierran');
  assert.equal((await opA.call('GET', '/api/devices')).status, 401);
  const again = await client().login('admin.sur', 'Clave-sur-123');
  assert.equal(again.status, 403, 'no puede volver a entrar');
  assert.equal(again.body.code, 'suspended');
  assert.match(again.body.error, /suspendida/);
  assert.equal((await adminB.call('GET', '/api/devices')).status, 200, 'la otra empresa sigue normal');
  let cfg = (await dev(devA.deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.blocked, false, 'durante la gracia los TV Box siguen funcionando');

  fakeNow += 5 * DAY + 1000;
  const poll = await dev(devA.deviceToken, 'GET', `/api/device/poll?cv=${v0}`);
  assert.notEqual(poll.body.configVersion, v0, 'el equipo se entera en el próximo pedido');
  cfg = (await dev(devA.deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.blocked, true);
  assert.equal(cfg.suspended, true);
  assert.equal(cfg.blockTitle, 'Servicio suspendido');
  assert.equal(cfg.blockMessage, 'Comuníquese con su proveedor.');
  assert.equal((await enroll(tokA, 'equipo-a-0099')).status, 403, 'no se suman equipos a una empresa suspendida');

  // Pasaron 5 días: las sesiones de 12 horas vencieron.
  assert.equal((await sup.call('GET', '/api/companies')).status, 401);
  await sup.login('admin', 'super-clave-123');
  assert.equal((await sup.call('POST', `/api/companies/${A}/activate`)).body.status, 'active');
  cfg = (await dev(devA.deviceToken, 'GET', '/api/device/config')).body;
  assert.equal(cfg.blocked, false);
  assert.equal((await adminA.login('admin.sur', 'Clave-sur-123')).status, 200);
  assert.equal((await adminA.call('GET', '/api/devices')).status, 200);
});

test('facturación: cuenta todo equipo registrado algún día del mes y cierra el mes', async () => {
  // Octubre: A tiene 1 equipo, B tiene 3. Se anota el día y se borra uno de B a mitad de mes.
  fakeNow = Date.parse('2026-10-20T15:00:00Z');
  ctx.tick();
  await adminB.login('admin.bar', 'Clave-bar-123');
  const bDevices = (await adminB.call('GET', '/api/devices')).body;
  assert.equal((await adminB.call('DELETE', `/api/devices/${bDevices[0].id}`)).status, 200);
  let r = (await sup.call('GET', '/api/billing?month=2026-10')).body;
  const count = (rep, name) => rep.rows.find((x) => x.name === name).devices;
  assert.equal(r.closed, false);
  assert.equal(count(r, 'Hotel Sur Mendoza'), 1, 'el alta rechazada durante la suspensión no cuenta');
  assert.equal(count(r, 'Bar Centro'), 3, 'el equipo borrado igual se factura en octubre');

  // Noviembre: el borrado ya no cuenta; octubre queda cerrado y no cambia.
  fakeNow = Date.parse('2026-11-02T15:00:00Z');
  ctx.tick();
  await sup.login('admin', 'super-clave-123');
  await adminA.login('admin.sur', 'Clave-sur-123');
  await adminB.login('admin.bar', 'Clave-bar-123');
  await enroll(tokB, 'equipo-b-0010');
  r = (await sup.call('GET', '/api/billing?month=2026-10')).body;
  assert.equal(r.closed, true);
  assert.equal(count(r, 'Bar Centro'), 3, 'octubre cerrado no cambia');
  const nov = (await sup.call('GET', '/api/billing')).body;
  assert.equal(nov.month, '2026-11');
  assert.equal(count(nov, 'Bar Centro'), 3, '2 que quedaron + 1 nuevo');
  assert.ok(nov.months.includes('2026-10'));

  const csv = await sup.call('GET', '/api/billing.csv?month=2026-10');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.startsWith('﻿Mes;Empresa;Razón social;CUIT/DNI;Tipo de impuesto;Estado;Equipos facturables'));
  assert.match(csv.text, /2026-10;Bar Centro;Bar Centro S\.A\.;30-71234567-1;Responsable inscripto;Activa;3;Sí/);
  assert.match(csv.text, /TOTAL;;;;;4/);
  const detail = await sup.call('GET', `/api/billing/${B}/devices.csv?month=2026-10`);
  assert.equal(detail.text.trim().split('\r\n').length, 4, 'encabezado + 3 equipos');
});

test('una empresa con equipos no se puede eliminar', async () => {
  assert.equal((await sup.call('DELETE', `/api/companies/${B}`)).status, 409);
  const e = await sup.call('POST', '/api/companies', empresa('Vacía'));
  assert.equal((await sup.call('DELETE', `/api/companies/${e.body.id}`)).status, 200);
});

test('un equipo enrolado con el token de otra empresa se muda limpio', async () => {
  const r = await enroll(tokB, 'equipo-a-0001');
  assert.equal(r.status, 200);
  assert.equal(r.body.deviceId, devA.deviceId);
  assert.equal((await adminA.call('GET', `/api/devices/${devA.deviceId}`)).status, 404);
  const moved = (await adminB.call('GET', `/api/devices/${devA.deviceId}`)).body;
  assert.equal(moved.blocked, false);
  assert.equal((await dev(r.body.deviceToken, 'GET', '/api/device/config')).body.title, 'Bar Centro');
});
