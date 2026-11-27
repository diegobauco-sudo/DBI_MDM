import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { empresa, usuario } from './datos.js';

// Una base creada por la v2.3.0 real (roles viejos en el CHECK de usuarios) tiene que migrar sin perder nada.
const here = path.dirname(new URL(import.meta.url).pathname);
const oldDir = path.join(here, '..', '.v230');
let hasOld = false;
try {
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.mkdirSync(oldDir);
  execSync(`git archive v2.3.0:server/src | tar -x -C "${oldDir}"`, { cwd: path.join(here, '..', '..'), stdio: 'pipe' });
  hasOld = fs.existsSync(path.join(oldDir, 'app.js'));
} catch { hasOld = false; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-roles-'));
let base, srv, ctx;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: r.status, body: json, text };
  };
  return { call, login: (username, password) => call('POST', '/api/login', { username, password }) };
}

async function startNew() {
  ctx = createApp({ dataDir: dir, adminPassword: 'Super-clave-123', billingIntervalMs: 0, updaterDir: path.join(dir, 'upd') });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
}

before(async () => {
  if (hasOld) {
    const { createApp: createOld } = await import(path.join(oldDir, 'app.js'));
    const old = createOld({ dataDir: dir, adminPassword: 'Super-clave-123', billingIntervalMs: 0, updaterDir: path.join(dir, 'upd') });
    await new Promise((ok) => { srv = old.app.listen(0, ok); });
    base = `http://127.0.0.1:${srv.address().port}`;
    const s = client();
    await s.login('admin', 'Super-clave-123');
    await s.call('POST', '/api/companies', empresa('Vieja SA', 'admin.vieja', 'Clave-vieja-123'));
    srv.closeAllConnections(); srv.close(); old.close();
  }
  await startNew();
});
after(() => {
  srv.closeAllConnections(); srv.close(); ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(oldDir, { recursive: true, force: true });
});

const sup = client();
const sysadmin = client();
const sysop = client();
const fact = client();
let A, B, C, opId;

test('una base de la v2.3.0 pasa a los roles nuevos sin perder usuarios', { skip: !hasOld && 'sin historial de git' }, async () => {
  assert.equal(ctx.db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal((await client().login('admin.vieja', 'Clave-vieja-123')).status, 200);
  const sql = ctx.db.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get().sql;
  assert.match(sql, /'sysoperator'/);
});

test('el administrador general crea usuarios del sistema; su rol no se puede repetir', async () => {
  await sup.login('admin', 'Super-clave-123');
  A = (await sup.call('POST', '/api/companies', empresa('Hotel Sur', 'admin.sur', 'Clave-sur-123'))).body.id;
  B = (await sup.call('POST', '/api/companies', empresa('Bar Centro', 'admin.bar', 'Clave-bar-123'))).body.id;
  assert.equal((await sup.call('POST', '/api/users', { ...usuario('otro.super', 'Clave-sup-123'), role: 'superadmin' })).status, 403);
  assert.equal((await sup.call('POST', '/api/users', { ...usuario('sys.admin', 'Clave-sys-123'), role: 'sysadmin' })).status, 200);
  assert.equal((await sup.call('POST', '/api/users', { ...usuario('fact', 'Clave-fac-123'), role: 'billing' })).status, 200);
  const op = await sup.call('POST', '/api/users', { ...usuario('sys.op', 'Clave-op-1234'), role: 'sysoperator', companyIds: [A] });
  assert.equal(op.status, 200);
  assert.deepEqual(op.body.companies.map((c) => c.name), ['Hotel Sur']);
  opId = op.body.id;
  const list = (await sup.call('GET', '/api/users?scope=system')).body;
  assert.deepEqual(list.map((u) => u.role), ['superadmin', 'sysadmin', 'sysoperator', 'billing']);
  const me = (await sup.call('GET', '/api/me')).body;
  assert.equal(me.perms.systemUsers, true);
});

test('el administrador del sistema modifica todo, pero no crea administradores ni toca al principal', async () => {
  assert.equal((await sysadmin.login('sys.admin', 'Clave-sys-123')).status, 200);
  assert.equal((await sysadmin.call('GET', '/api/companies')).body.length, hasOld ? 3 : 2);
  assert.equal((await sysadmin.call('GET', '/api/settings')).status, 200);
  assert.equal((await sysadmin.call('GET', '/api/billing')).status, 200);
  assert.equal((await sysadmin.call('GET', '/api/updates')).status, 200);
  const c = await sysadmin.call('POST', '/api/companies', empresa('Temporal', 'admin.tmp', 'Clave-tmp-123'));
  assert.equal(c.status, 200);
  assert.equal((await sysadmin.call('DELETE', `/api/companies/${c.body.id}`)).status, 200);
  assert.equal((await sysadmin.call('POST', '/api/users', { ...usuario('otro.sys', 'Clave-sys-123'), role: 'sysadmin' })).status, 403);
  assert.equal((await sysadmin.call('POST', '/api/users', { ...usuario('fact2', 'Clave-fac-123'), role: 'billing' })).status, 200);
  const principal = (await sup.call('GET', '/api/users?scope=system')).body.find((u) => u.role === 'superadmin');
  assert.equal((await sysadmin.call('POST', `/api/users/${principal.id}/password`, { password: 'Robada-clave-1' })).status, 403);
  assert.equal((await sysadmin.call('DELETE', `/api/users/${principal.id}`)).status, 403);
  // Entra a cualquier empresa como administrador.
  assert.equal((await sysadmin.call('POST', '/api/context', { companyId: B })).status, 200);
  assert.equal((await sysadmin.call('POST', '/api/profiles', { name: 'Nuevo' })).status, 200);
});

test('el operador del sistema ve solo sus empresas, crea empresas y no las borra', async () => {
  assert.equal((await sysop.login('sys.op', 'Clave-op-1234')).status, 200);
  assert.deepEqual((await sysop.call('GET', '/api/companies')).body.map((c) => c.name), ['Hotel Sur']);
  assert.equal((await sysop.call('POST', '/api/context', { companyId: B })).status, 404, 'no está asignado a Bar Centro');
  assert.equal((await sysop.call('POST', `/api/companies/${B}/suspend`)).status, 403);
  assert.equal((await sysop.call('PATCH', `/api/companies/${B}`, { name: 'X' })).status, 404, 'una empresa no asignada no existe para él');
  const nueva = await sysop.call('POST', '/api/companies', empresa('Kiosco Norte', 'admin.kiosco', 'Clave-kio-123'));
  assert.equal(nueva.status, 200);
  C = nueva.body.id;
  assert.deepEqual((await sysop.call('GET', '/api/companies')).body.map((c) => c.name), ['Hotel Sur', 'Kiosco Norte'], 'la que crea queda asignada');
  assert.equal((await sysop.call('PATCH', `/api/companies/${C}`, { phone: '261 999 8888' })).status, 200);
  assert.equal((await sysop.call('DELETE', `/api/companies/${C}`)).status, 403);
  for (const u of ['/api/billing', '/api/settings', '/api/updates', '/api/users?scope=system', '/api/backups/general']) {
    assert.equal((await sysop.call('GET', u)).status, 403, u);
  }
  // Dentro de su empresa es administrador.
  assert.equal((await sysop.call('POST', '/api/context', { companyId: A })).status, 200);
  assert.equal((await sysop.call('POST', '/api/clients', { extId: '1', name: 'Cliente' })).status, 200);
  assert.equal((await sysop.call('POST', '/api/users', { ...usuario('op.sur', 'Clave-ops-123'), role: 'operator' })).status, 200);
  // Al quitarle la empresa, pierde el acceso aunque la tenga elegida.
  assert.equal((await sup.call('PATCH', `/api/users/${opId}`, { companyIds: [C] })).status, 200);
  assert.equal((await sysop.call('GET', '/api/devices')).status, 409);
  assert.deepEqual((await sysop.call('GET', '/api/companies')).body.map((c) => c.name), ['Kiosco Norte']);
});

test('facturación ve todo y exporta, y solo suspende o reactiva empresas', async () => {
  assert.equal((await fact.login('fact', 'Clave-fac-123')).status, 200);
  assert.equal((await fact.call('GET', '/api/companies')).body.length, hasOld ? 4 : 3);
  const csv = await fact.call('GET', '/api/billing.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Hotel Sur/);
  assert.equal((await fact.call('POST', `/api/companies/${B}/suspend`)).status, 200);
  assert.equal((await fact.call('POST', `/api/companies/${B}/activate`)).status, 200);
  assert.equal((await fact.call('POST', '/api/companies', empresa('No', 'x.no', 'Clave-noo-123'))).status, 403);
  assert.equal((await fact.call('PATCH', `/api/companies/${B}`, { name: 'Otra' })).status, 403);
  assert.equal((await fact.call('DELETE', `/api/companies/${C}`)).status, 403);
  assert.equal((await fact.call('GET', '/api/settings')).status, 403);
  assert.equal((await fact.call('GET', '/api/audit')).status, 200);
  // Dentro de una empresa, solo lectura.
  assert.equal((await fact.call('POST', '/api/context', { companyId: A })).status, 200);
  assert.equal((await fact.call('GET', '/api/devices')).status, 200);
  assert.equal((await fact.call('GET', '/api/clients')).status, 200);
  assert.equal((await fact.call('GET', '/api/users')).status, 200);
  const ro = await fact.call('POST', '/api/clients', { extId: '9', name: 'X' });
  assert.equal(ro.status, 403);
  assert.match(ro.body.error, /solo lectura/);
  assert.equal((await fact.call('POST', '/api/devices/bulk', { ids: ['x'], action: 'message', payload: { body: 'hola' } })).status, 403);
  assert.equal((await fact.call('GET', '/api/enroll-tokens')).status, 403);
  assert.equal((await fact.call('GET', '/api/backups/empresa')).status, 403);
  assert.equal((await fact.call('POST', '/api/users', { ...usuario('x.y', 'Clave-xyz-123'), role: 'operator' })).status, 403);
});

test('el rol se cambia dentro del mismo ámbito y nadie se cambia el propio', async () => {
  assert.equal((await sup.call('PATCH', `/api/users/${opId}`, { role: 'billing' })).status, 200);
  assert.deepEqual((await sup.call('GET', '/api/users?scope=system')).body.find((u) => u.id === opId).companies, undefined, 'facturación no tiene empresas asignadas');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM user_companies WHERE user_id=?').get(opId).n, 0);
  assert.equal((await sup.call('PATCH', `/api/users/${opId}`, { role: 'admin' })).status, 400, 'del sistema a empresa no');
  const me = (await sup.call('GET', '/api/me')).body;
  const self = (await sup.call('GET', '/api/users?scope=system')).body.find((u) => u.username === me.username);
  assert.equal((await sup.call('PATCH', `/api/users/${self.id}`, { role: 'billing' })).status, 400);
  // En una empresa: su administrador cambia un operador a administrador.
  const adm = client();
  await adm.login('admin.sur', 'Clave-sur-123');
  const op = (await adm.call('GET', '/api/users')).body.find((u) => u.username === 'op.sur');
  const r = await adm.call('PATCH', `/api/users/${op.id}`, { role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.roleLabel, 'administrador de la empresa');
  assert.equal((await adm.call('PATCH', `/api/users/${op.id}`, { role: 'sysadmin' })).status, 400);
});
