import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';

/**
 * Contenido de un respaldo, antes de cifrar: un .tar.gz con
 *   manifest.json   qué es, de qué versión y de cuándo
 *   wifly.db        (general) copia consistente de toda la base
 *   company.json    (empresa) los datos de esa empresa
 *   files/<sha>     los archivos subidos (APK, imágenes) que corresponden
 */

const tmpName = (tmpDir, prefix) => path.join(tmpDir, `${prefix}-${crypto.randomUUID()}`);

/** Enlace duro si se puede (no ocupa espacio extra); si no, copia. */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

async function pack(stage, out) {
  await tar.c({ gzip: true, file: out, cwd: stage, portable: true }, fs.readdirSync(stage));
  fs.rmSync(stage, { recursive: true, force: true });
}

export async function buildGeneral({ db, filesDir, tmpDir, version }) {
  const stage = tmpName(tmpDir, 'stage');
  fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
  // VACUUM INTO da una copia consistente aunque el servidor siga atendiendo.
  db.exec(`VACUUM INTO '${path.join(stage, 'wifly.db').replace(/'/g, "''")}'`);
  let count = 0;
  for (const name of fs.readdirSync(filesDir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    linkOrCopy(path.join(filesDir, name), path.join(stage, 'files', name));
    count++;
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ kind: 'general', version, createdAt: Date.now(), files: count }));
  const out = `${tmpName(tmpDir, 'general')}.tar.gz`;
  await pack(stage, out);
  return out;
}

/** Lo que pertenece a una empresa. La facturación no se incluye: es del administrador general. */
export function exportCompany(db, companyId) {
  const all = (sql) => db.prepare(sql).all(companyId);
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if (!company) throw new Error('Empresa inexistente');
  return {
    company,
    users: all('SELECT * FROM users WHERE company_id=?'),
    clients: all('SELECT * FROM clients WHERE company_id=?'),
    profiles: all('SELECT * FROM profiles WHERE company_id=?'),
    devices: all('SELECT * FROM devices WHERE company_id=?'),
    enrollTokens: all('SELECT * FROM enroll_tokens WHERE company_id=?'),
    files: all('SELECT * FROM files WHERE company_id=?'),
    audit: all('SELECT * FROM audit WHERE company_id=? ORDER BY id DESC LIMIT 5000'),
  };
}

export async function buildCompany({ db, filesDir, tmpDir, version, companyId }) {
  const data = exportCompany(db, companyId);
  const stage = tmpName(tmpDir, 'stage');
  fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
  for (const sha of new Set(data.files.map((f) => f.sha))) {
    const src = path.join(filesDir, sha);
    if (fs.existsSync(src)) linkOrCopy(src, path.join(stage, 'files', sha));
  }
  fs.writeFileSync(path.join(stage, 'company.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
    kind: 'company', version, createdAt: Date.now(), companyId, companyName: data.company.name, devices: data.devices.length, files: data.files.length,
  }));
  const out = `${tmpName(tmpDir, 'company')}.tar.gz`;
  await pack(stage, out);
  return out;
}

/** Abre un respaldo ya descifrado. tar descarta rutas absolutas y "..", así que no puede escribir fuera de dest. */
export async function extract(file, tmpDir) {
  const dest = tmpName(tmpDir, 'restore');
  fs.mkdirSync(dest, { recursive: true });
  try {
    await tar.x({ file, cwd: dest, strict: true, preservePaths: false, filter: (p, entry) => entry.type === 'File' || entry.type === 'Directory' });
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error('El respaldo está dañado o no es de WiFly');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error('El respaldo no tiene la descripción de su contenido');
  }
  return { dir: dest, manifest };
}
