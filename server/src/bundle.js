import yauzl from 'yauzl';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import ApkReader from 'adbkit-apkreader';

const MAX_PARTS = 120;

export class BundleError extends Error {}

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', (e) => { out.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
}

const openEntry = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
});

export async function readApkManifest(file) {
  try {
    const m = await (await ApkReader.open(file)).readManifest();
    if (!m?.package) throw new Error('sin paquete');
    return m;
  } catch {
    throw new BundleError('El archivo no es un APK válido');
  }
}

/**
 * Mira el contenido de lo que se subió.
 * Devuelve { kind: 'single' } para un APK común, o { kind: 'split', parts, warning } para .apks/.xapk/.apkm,
 * con cada parte ya extraída a un archivo temporal, hasheada y leída.
 */
export async function inspectUpload(file, tmpDir, maxBytes) {
  let zip;
  try {
    zip = await openZip(file);
  } catch {
    throw new BundleError('El archivo no es un APK ni un paquete de APK divididas. Si es un .apkm de APKMirror, puede venir cifrado: probá con la versión .apk o .apks.');
  }
  try {
    const entries = await listEntries(zip);
    if (entries.some((e) => e.fileName === 'AndroidManifest.xml')) return { kind: 'single' };

    let apks = entries.filter((e) => /\.apk$/i.test(e.fileName) && !e.fileName.startsWith('standalones/') && !e.fileName.endsWith('/'));
    // bundletool incluye una versión "universal" cuando se pide; si es la única, es un APK común.
    const universal = apks.find((e) => path.basename(e.fileName) === 'universal.apk');
    if (universal && apks.length === 1) apks = [universal];
    else apks = apks.filter((e) => e !== universal);
    if (!apks.length) throw new BundleError('El paquete no contiene ningún APK');
    if (apks.length > MAX_PARTS) throw new BundleError(`El paquete tiene demasiadas partes (${apks.length})`);
    const warning = entries.some((e) => /\.obb$/i.test(e.fileName))
      ? 'El paquete trae archivos OBB (datos extra), que WiFly no instala. La app puede pedir descargarlos al abrirla.'
      : '';

    const parts = [];
    let total = 0;
    try {
      for (const e of apks) {
        total += e.uncompressedSize;
        if (total > maxBytes) throw new BundleError('El paquete descomprimido supera el tamaño máximo permitido');
        const out = path.join(tmpDir, crypto.randomUUID());
        const hash = crypto.createHash('sha256');
        let size = 0;
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > e.uncompressedSize + 1024 || size > maxBytes) return cb(new BundleError('Contenido del paquete inconsistente'));
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        parts.push({ tmp: out, file: e.fileName });
        await pipeline(await openEntry(zip, e), counter, fs.createWriteStream(out));
        const m = await readApkManifest(out);
        Object.assign(parts.at(-1), { sha: hash.digest('hex'), size, package: m.package, split: m.split || '', versionCode: m.versionCode || 0, versionName: String(m.versionName ?? ''), manifest: m });
      }
      const bases = parts.filter((p) => !p.split);
      if (bases.length !== 1) throw new BundleError(bases.length ? 'El paquete tiene más de un APK base' : 'El paquete no tiene el APK base');
      const base = bases[0];
      for (const p of parts) {
        if (p.package !== base.package) throw new BundleError(`El paquete mezcla apps distintas (${base.package} y ${p.package})`);
        if (p.versionCode !== base.versionCode) throw new BundleError(`La parte ${p.split} es de otra versión que el APK base`);
      }
      if (new Set(parts.map((p) => p.split)).size !== parts.length) throw new BundleError('El paquete repite partes');
      parts.sort((a, b) => (a === base ? -1 : b === base ? 1 : a.split.localeCompare(b.split)));
      return { kind: 'split', parts, base, warning };
    } catch (err) {
      for (const p of parts) fs.rmSync(p.tmp, { force: true });
      throw err;
    }
  } finally {
    zip.close();
  }
}
