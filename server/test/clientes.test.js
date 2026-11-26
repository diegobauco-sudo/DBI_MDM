import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { buildCompany, extract } from '../src/backup/archive.js';
import { restoreCompany } from '../src/backup/restore.js';
import { passwordProblems, cleanTaxId } from '../src/validate.js';
import { empresa, usuario } from './datos.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-clientes-'));
let base, srv, ctx;
const mails = [];

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, login: (username, password) => call('POST', '/api/login', { username, password }) };
}
async function enroll(token, installId) {
  const r = await fetch(`${base}/api/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, installId, model: 'Q5' }) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  ctx = createApp({ dataDir: dir, adminPassword: 'Super-clave-123', billingIntervalMs: 0, publicUrl: 'https://mdm.ejemplo.com', mailTransport: async (m) => { mails.push(m); } });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const sup = client();
const adm = client();
const op = client();
let C, devs = [];

test('la política de claves pide largo, mayúscula, minúscula, número y carácter especial', () => {
  assert.deepEqual(passwordProblems('Clave-segura-1'), []);
  assert.deepEqual(passwordProblems('clave-segura-1'), ['una mayúscula']);
  assert.deepEqual(passwordProblems('ClaveSegura12'), ['un carácter especial']);
  assert.deepEqual(passwordProblems('Ab1!'), ['10 caracteres']);
});

test('documentos: DNI con puntos, CUIT con dígito verificador', () => {
  assert.equal(cleanTaxId('12345678'), '12.345.678');
  assert.equal(cleanTaxId('30712345671'), '30-71234567-1');
  assert.equal(cleanTaxId('30-71234567-1'), '30-71234567-1');
  assert.throws(() => cleanTaxId('30-71234567-2'), /dígito verificador/);
  assert.throws(() => cleanTaxId('12345678', { cuitOnly: true }), /11 dígitos/);
  assert.throws(() => cleanTaxId('123'), /7 u 8/);
});

test('crear una empresa exige los datos fiscales y de contacto', async () => {
  await sup.login('admin', 'Super-clave-123');
  const bad = async (patch, re) => {
    const r = await sup.call('POST', '/api/companies', { ...empresa('Prueba'), ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.match(r.body.error, re);
  };
  await bad({ legalName: '' }, /razón social/);
  await bad({ taxAddress: '' }, /domicilio fiscal/);
  await bad({ taxCondition: '' }, /tipo de impuesto/);
  await bad({ taxCondition: 'mono', taxId: '12.345.678' }, /CUIT/);
  await bad({ taxId: '30-71234567-9' }, /verificador/);
  await bad({ email: 'no-es-email' }, /email/);
  await bad({ phone: '' }, /teléfono/);
  // Consumidor final puede ir con DNI.
  const r = await sup.call('POST', '/api/companies', empresa('Hotel Sur', 'admin.sur', 'Clave-sur-123', { taxCondition: 'cf', taxId: '20111222' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.taxId, '20.111.222');
  assert.equal(r.body.taxConditionLabel, 'Consumidor final');
  C = r.body.id;
});

test('el administrador de la empresa se crea con sus datos y una clave segura', async () => {
  const weak = await sup.call('POST', '/api/companies', empresa('Otra', 'admin.otra', 'clave-debil-1'));
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /mayúscula/);
  const users = (await sup.call('GET', '/api/companies')).body;
  assert.equal(users.some((c) => c.name === 'Otra'), false, 'no queda a medias');
  assert.equal((await adm.login('admin.sur', 'Clave-sur-123')).status, 200);
  const me = (await adm.call('GET', '/api/me')).body;
  assert.equal(me.fullName, 'Nombre admin.sur');
  assert.equal(me.displayName, 'Nombre admin.sur');
});

test('los usuarios se crean con nombre, email y clave segura, y se pueden editar', async () => {
  const missing = await adm.call('POST', '/api/users', { username: 'op.sur', password: 'Clave-op-1234', role: 'operator' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /nombre completo/);
  const weak = await adm.call('POST', '/api/users', { ...usuario('op.sur', 'claveop12345'), role: 'operator' });
  assert.match(weak.body.error, /Le falta: una mayúscula, un carácter especial/);
  const r = await adm.call('POST', '/api/users', { ...usuario('op.sur', 'Clave-op-1234', { displayName: 'Juan' }), role: 'operator' });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayName, 'Juan');
  const ed = await adm.call('PATCH', `/api/users/${r.body.id}`, { phone: '+54 9 261 444 5555', email: 'Juan@Ejemplo.com' });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.email, 'juan@ejemplo.com');
  assert.equal(ed.body.displayName, 'Juan');
  assert.equal((await adm.call('POST', `/api/users/${r.body.id}/password`, { password: 'corta' })).status, 400);
  assert.equal((await op.login('op.sur', 'Clave-op-1234')).status, 200);
  // Cada uno edita sus propios datos.
  assert.equal((await op.call('PUT', '/api/me', { fullName: 'Juan Pérez', displayName: 'Juancho', email: 'juan@ejemplo.com' })).status, 200);
  assert.equal((await op.call('GET', '/api/me')).body.displayName, 'Juancho');
  assert.equal((await op.call('POST', '/api/password', { current: 'Clave-op-1234', next: 'sinmayuscula-1' })).status, 400);
});

test('clientes: alta con ID manual, validaciones y orden por ID', async () => {
  for (const [extId, name] of [['10', 'Carla Gómez'], ['2', 'Ana Ruiz'], ['A-7', 'Hostel Norte']]) {
    const r = await adm.call('POST', '/api/clients', { extId, name, taxId: '20123456786', address: 'Belgrano 50', phone: '261 400 1000', email: `${extId}@cli.com` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  assert.equal((await adm.call('POST', '/api/clients', { extId: '2', name: 'Repetido' })).status, 409);
  assert.equal((await adm.call('POST', '/api/clients', { extId: 'con espacio', name: 'X' })).status, 400);
  assert.equal((await adm.call('POST', '/api/clients', { extId: '99', name: '' })).status, 400);
  assert.equal((await adm.call('POST', '/api/clients', { extId: '99', name: 'X', taxId: '1' })).status, 400);
  const list = (await adm.call('GET', '/api/clients')).body;
  assert.deepEqual(list.map((c) => c.extId), ['2', '10', 'A-7'], 'orden natural: 2 antes que 10');
  assert.equal(list[0].taxId, '20-12345678-6');
  // El operador ve los clientes pero no los modifica.
  assert.equal((await op.call('GET', '/api/clients')).status, 200);
  assert.equal((await op.call('POST', '/api/clients', { extId: '50', name: 'X' })).status, 403);
  assert.equal((await op.call('PUT', `/api/clients/${list[0].id}`, { extId: '2', name: 'X' })).status, 403);
});

test('los equipos se asignan a un cliente: por token, desde el equipo o en grupo', async () => {
  const clients = (await adm.call('GET', '/api/clients')).body;
  const ana = clients.find((c) => c.extId === '2');
  const carla = clients.find((c) => c.extId === '10');
  const tok = (await adm.call('POST', '/api/enroll-tokens', { label: 'Ana', clientId: ana.id })).body;
  assert.equal(tok.clientName, '2 · Ana Ruiz');
  const tokFree = (await adm.call('POST', '/api/enroll-tokens', { label: 'Sin cliente' })).body;
  devs = [(await enroll(tok.token, 'install-0001')).body.deviceId, (await enroll(tok.token, 'install-0002')).body.deviceId, (await enroll(tokFree.token, 'install-0003')).body.deviceId];
  let detail = (await adm.call('GET', `/api/clients/${ana.id}`)).body;
  assert.equal(detail.devices, 2);
  assert.equal(detail.deviceList.length, 2);
  assert.equal(detail.deviceList[0].clientName, 'Ana Ruiz');

  assert.equal((await adm.call('PATCH', `/api/devices/${devs[2]}`, { clientId: carla.id })).status, 200);
  assert.equal((await adm.call('GET', `/api/devices/${devs[2]}`)).body.clientExtId, '10');
  // Asignación en grupo, y el operador no puede cambiar clientes.
  assert.equal((await op.call('POST', '/api/devices/bulk', { ids: [devs[0]], action: 'assignClient', payload: { clientId: carla.id } })).status, 403);
  assert.equal((await adm.call('POST', '/api/devices/bulk', { ids: [devs[0]], action: 'assignClient', payload: { clientId: carla.id } })).status, 200);
  const list = (await adm.call('GET', '/api/clients')).body;
  assert.equal(list.find((c) => c.extId === '2').devices, 1);
  assert.equal(list.find((c) => c.extId === '10').devices, 2);
  // Un cliente de otra empresa no se puede usar.
  const other = await sup.call('POST', '/api/companies', empresa('Bar Centro', 'admin.bar', 'Clave-bar-123'));
  const bar = client();
  await bar.login('admin.bar', 'Clave-bar-123');
  const barClient = (await bar.call('POST', '/api/clients', { extId: '1', name: 'Cliente del bar' })).body;
  assert.equal((await adm.call('PATCH', `/api/devices/${devs[1]}`, { clientId: barClient.id })).status, 400);
  assert.equal((await adm.call('GET', `/api/clients/${barClient.id}`)).status, 404);
  assert.equal(other.status, 200);
  // Borrar un cliente deja sus equipos sin cliente.
  assert.equal((await adm.call('DELETE', `/api/clients/${ana.id}`)).status, 200);
  assert.equal((await adm.call('GET', `/api/devices/${devs[1]}`)).body.clientId, null);
  detail = (await adm.call('GET', '/api/devices')).body;
  assert.equal(detail.length, 3, 'los equipos siguen');
});

test('el respaldo de la empresa incluye los clientes y su vínculo con los equipos', async () => {
  const tmp = path.join(dir, 'tmp');
  const file = await buildCompany({ db: ctx.db, filesDir: path.join(dir, 'files'), tmpDir: tmp, version: 'test', companyId: C });
  const extracted = await extract(file, tmp);
  const before = (await adm.call('GET', '/api/clients')).body;
  await adm.call('DELETE', `/api/clients/${before[0].id}`);
  await adm.call('POST', '/api/clients', { extId: 'Z9', name: 'Agregado después' });
  const r = restoreCompany({ db: ctx.db, filesDir: path.join(dir, 'files'), extracted, companyId: C });
  assert.equal(r.clients, 2);
  await adm.login('admin.sur', 'Clave-sur-123');
  const after = (await adm.call('GET', '/api/clients')).body;
  assert.deepEqual(after.map((c) => [c.extId, c.devices]), before.map((c) => [c.extId, c.devices]));
  const co = (await sup.call('GET', '/api/companies')).body.find((c) => c.id === C);
  assert.equal(co.legalName, 'Hotel Sur S.A.');
  const op2 = client();
  assert.equal((await op2.login('op.sur', 'Clave-op-1234')).status, 200);
  assert.equal((await op2.call('GET', '/api/me')).body.displayName, 'Juancho');
});

test('editar una empresa valida los datos y permite completar una vieja', async () => {
  assert.equal((await sup.call('PATCH', `/api/companies/${C}`, { taxCondition: 'ri' })).status, 400, 'responsable inscripto con DNI');
  const ok = await sup.call('PATCH', `/api/companies/${C}`, { taxCondition: 'ri', taxId: '30712345671', phone: '0261 555-1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.taxId, '30-71234567-1');
  // Una empresa creada antes de la v2.3 no tiene datos fiscales: igual se puede renombrar.
  ctx.db.prepare(`INSERT INTO companies (name, created_at) VALUES ('Vieja', 0)`).run();
  const vieja = (await sup.call('GET', '/api/companies')).body.find((c) => c.name === 'Vieja');
  assert.equal((await sup.call('PATCH', `/api/companies/${vieja.id}`, { name: 'Vieja SRL' })).status, 200);
});

test('recuperar la clave por email: sin correo configurado lo dice', async () => {
  const r = await fetch(`${base}/api/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin.sur' }) });
  assert.equal(r.status, 503);
});

test('recuperar la clave por email: el enlace sirve una vez y por una hora', async () => {
  assert.equal((await sup.call('PUT', '/api/settings', { brandPhrase: '', graceDays: 7, smtpHost: 'smtp.ejemplo.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUser: 'u', smtpPass: 'p', smtpFrom: 'mail con salto\r\nBcc: x@y.com' })).status, 400);
  assert.equal((await sup.call('PUT', '/api/settings', { brandPhrase: '', graceDays: 7, smtpHost: 'smtp.ejemplo.com', smtpPort: 587, smtpSecurity: 'starttls', smtpUser: 'u', smtpPass: 'p', smtpFrom: 'WiFly MDM <avisos@ejemplo.com>' })).status, 200);
  const s = (await sup.call('GET', '/api/settings')).body;
  assert.equal(s.mailReady, true);
  assert.equal(s.smtpPassSet, true);
  assert.equal(s.smtpPass, undefined, 'la clave SMTP no vuelve al panel');
  assert.equal((await sup.call('POST', '/api/settings/mail-test', { to: 'yo@ejemplo.com' })).status, 200);
  assert.equal(mails.at(-1).to, 'yo@ejemplo.com');

  const forgot = (login) => fetch(`${base}/api/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login }) }).then((r) => r.json());
  mails.length = 0;
  const unknown = await forgot('no-existe');
  const known = await forgot('JUAN@ejemplo.com');
  assert.equal(unknown.message, known.message, 'misma respuesta exista o no');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'juan@ejemplo.com');
  const token = /#reset=([A-Za-z0-9_-]+)/.exec(mails[0].text)[1];
  assert.match(mails[0].text, /https:\/\/mdm\.ejemplo\.com\/#reset=/, 'usa la dirección pública, no la del pedido');

  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await post('/api/password/reset-info', { token })).body.displayName, 'Juancho');
  assert.equal((await post('/api/password/reset', { token, password: 'debil' })).status, 400);
  assert.equal((await post('/api/password/reset', { token, password: 'Nueva-clave-99' })).status, 200);
  assert.equal((await post('/api/password/reset', { token, password: 'Otra-clave-99' })).status, 400, 'el enlace se usa una sola vez');
  assert.equal((await client().login('op.sur', 'Clave-op-1234')).status, 401);
  assert.equal((await client().login('op.sur', 'Nueva-clave-99')).status, 200);
});

test('el administrador sin email propio recupera con el email de la empresa', async () => {
  ctx.db.prepare(`UPDATE users SET email='' WHERE username='admin.bar'`).run();
  mails.length = 0;
  await fetch(`${base}/api/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'contacto@barcentro.com' }) });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'contacto@barcentro.com');
  assert.match(mails[0].text, /usuario admin\.bar/);
});
