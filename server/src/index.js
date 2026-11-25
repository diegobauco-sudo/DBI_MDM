import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { applyPendingRestore } from './backup/restore.js';

const dataDir = process.env.DATA_DIR || path.resolve('data');
const port = Number(process.env.PORT || 8080);
const publicUrl = process.env.PUBLIC_URL || '';

// Una restauración completa pedida desde el panel se aplica acá, antes de abrir la base.
fs.mkdirSync(dataDir, { recursive: true });
applyPendingRestore(dataDir);

const { app, generatedPassword } = createApp({
  dataDir,
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
  secureCookies: publicUrl.startsWith('https://'),
  trustProxy: process.env.TRUST_PROXY === '1',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 1024),
  updaterDir: process.env.UPDATER_DIR || '/updater',
  publicUrl,
});

if (generatedPassword) {
  const f = path.join(dataDir, 'clave-inicial-admin.txt');
  fs.writeFileSync(f, `${generatedPassword}\n`, { mode: 0o600 });
  console.log(`Clave inicial del panel guardada en ${f}. Cambiala después de entrar.`);
}

// Mayor que el long polling de 25 s, para que el proxy y Node no corten la espera.
const server = app.listen(port, () => console.log(`WiFly MDM escuchando en el puerto ${port}`));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
