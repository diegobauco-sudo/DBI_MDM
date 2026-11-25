import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Formato de un respaldo cifrado (.wfbk):
 *   "WFLYBK01" (8 bytes) · sal (16) · IV (12) · datos cifrados con AES-256-GCM · etiqueta de autenticación (16)
 * La clave sale de la contraseña con scrypt. Sin la contraseña no se puede leer ni modificar sin que se note.
 */
const MAGIC = Buffer.from('WFLYBK01');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HEADER = MAGIC.length + 16 + 12;

export class BackupPasswordError extends Error {}

const deriveKey = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(password), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
});

export async function encryptFile(src, dest, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false }).catch(async (e) => { out.destroy(); throw e; });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())));
}

/** Descifra a dest. Si la contraseña es incorrecta o el archivo se alteró, borra lo escrito y avisa. */
export async function decryptFile(src, dest, password) {
  const size = fs.statSync(src).size;
  if (size < HEADER + 16) throw new BackupPasswordError('El archivo no es un respaldo de WiFly');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, HEADER, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 8).equals(MAGIC)) throw new BackupPasswordError('El archivo no es un respaldo de WiFly');
  const key = await deriveKey(password, head.subarray(8, 24));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(24, HEADER));
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: HEADER, end: size - 17 }), decipher, fs.createWriteStream(dest));
  } catch {
    fs.rmSync(dest, { force: true });
    throw new BackupPasswordError('Contraseña incorrecta o archivo de respaldo dañado');
  }
}
