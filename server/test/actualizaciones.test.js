import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifly-upd-'));
const upd = path.join(dir, 'updater');
fs.mkdirSync(upd);
let base, srv, ctx, cookie = '';
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-wifly': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  ctx = createApp({ dataDir: dir, adminPassword: 'clave-de-prueba-1', updaterDir: upd, billingIntervalMs: 0 });
  await new Promise((ok) => { srv = ctx.app.listen(0, ok); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('el chequeo de salud informa la versión sin pedir sesión', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, ctx.version);
});

test('sin activar en el CT, el panel lo dice y no deja pedir nada', async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'clave-de-prueba-1' });
  const s = (await call('GET', '/api/updates')).body;
  assert.equal(s.enabled, false);
  assert.equal(s.current, `v${ctx.version}`);
  assert.equal((await call('POST', '/api/updates/check')).status, 409);
});

test('con el actualizador activo: buscar y actualizar dejan el pedido para el CT', async () => {
  fs.writeFileSync(path.join(upd, 'updater.json'), JSON.stringify({ repo: 'usuario/wifly-mdm' }));
  const c = await call('POST', '/api/updates/check');
  assert.equal(c.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(upd, 'request.json'))).action, 'check');
  assert.equal((await call('POST', '/api/updates/check')).status, 409, 'no se apilan pedidos');
  // El CT atiende el pedido y publica las versiones disponibles.
  fs.unlinkSync(path.join(upd, 'request.json'));
  fs.writeFileSync(path.join(upd, 'status.json'), JSON.stringify({ state: 'idle', available: ['v9.0.0', 'malo;rm -rf'], log: ['ok'] }));
  const s = (await call('GET', '/api/updates')).body;
  assert.deepEqual(s.available, ['v9.0.0'], 'solo versiones con formato válido');
  assert.equal((await call('POST', '/api/updates/apply', { version: 'v8.0.0' })).status, 400, 'solo versiones publicadas');
  assert.equal((await call('POST', '/api/updates/apply', { version: 'malo;rm -rf' })).status, 400);
  const a = await call('POST', '/api/updates/apply', { version: 'v9.0.0' });
  assert.equal(a.status, 200);
  assert.equal(a.body.state, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(upd, 'request.json'))).version, 'v9.0.0');
});

test('solo el administrador general puede actualizar', async () => {
  const c = await call('POST', '/api/companies', { name: 'Cliente', adminUser: 'admin.cliente', adminPassword: 'clave-cli-123' });
  assert.equal(c.status, 200);
  cookie = '';
  await call('POST', '/api/login', { username: 'admin.cliente', password: 'clave-cli-123' });
  assert.equal((await call('GET', '/api/updates')).status, 403);
  assert.equal((await call('POST', '/api/updates/apply', { version: 'v9.0.0' })).status, 403);
});
