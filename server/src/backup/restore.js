import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Restaurar el sistema completo no se puede hacer con la base abierta. Se deja preparado en
 * restore-pending/ y el servidor se reinicia; al arrancar, applyPendingRestore() guarda el estado
 * actual en pre-restore-<fecha>/ y pone el respaldo en su lugar.
 */
export function stageGeneralRestore(dataDir, extracted) {
  const dbFile = path.join(extracted.dir, 'wifly.db');
  if (extracted.manifest.kind !== 'general' || !fs.existsSync(dbFile)) throw new Error('Este archivo no es un respaldo del sistema completo');
  try {
    const probe = new DatabaseSync(dbFile, { readOnly: true });
    const ok = probe.prepare('PRAGMA integrity_check').get();
    probe.close();
    if (Object.values(ok)[0] !== 'ok') throw new Error('bad');
  } catch {
    throw new Error('La base de datos del respaldo está dañada');
  }
  const pending = path.join(dataDir, 'restore-pending');
  fs.rmSync(pending, { recursive: true, force: true });
  fs.renameSync(extracted.dir, pending);
}

export function applyPendingRestore(dataDir, log = console.log) {
  const pending = path.join(dataDir, 'restore-pending');
  if (!fs.existsSync(path.join(pending, 'wifly.db'))) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const keep = path.join(dataDir, `pre-restore-${stamp}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const name of ['wifly.db', 'wifly.db-wal', 'wifly.db-shm', 'files']) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, name));
  }
  fs.renameSync(path.join(pending, 'wifly.db'), path.join(dataDir, 'wifly.db'));
  fs.renameSync(path.join(pending, 'files'), path.join(dataDir, 'files'));
  fs.rmSync(pending, { recursive: true, force: true });
  // Se conservan las dos copias previas más recientes por si hay que deshacer.
  const olds = fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-restore-')).sort();
  for (const n of olds.slice(0, -2)) fs.rmSync(path.join(dataDir, n), { recursive: true, force: true });
  log(`Respaldo restaurado. El estado anterior quedó en ${keep}`);
  return true;
}

/**
 * Restaura una empresa sin tocar a las demás: reemplaza sus usuarios, perfiles, equipos, tokens y archivos.
 * Los identificadores internos se reasignan para no chocar con datos creados después en otras empresas.
 * Lo que hoy pertenece a otra empresa (un equipo que se mudó, un usuario con el mismo nombre) se omite y se informa.
 */
export function restoreCompany({ db, filesDir, extracted, companyId }) {
  const m = extracted.manifest;
  if (m.kind !== 'company') throw new Error('Este archivo no es un respaldo de empresa');
  if (Number(m.companyId) !== Number(companyId)) throw new Error(`Este respaldo es de otra empresa (${m.companyName})`);
  const data = JSON.parse(fs.readFileSync(path.join(extracted.dir, 'company.json'), 'utf8'));
  const skipped = [];
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM devices WHERE company_id=?').run(companyId);
    db.prepare('DELETE FROM enroll_tokens WHERE company_id=?').run(companyId);
    db.prepare('DELETE FROM profiles WHERE company_id=?').run(companyId);
    db.prepare('DELETE FROM files WHERE company_id=?').run(companyId);
    db.prepare('DELETE FROM users WHERE company_id=?').run(companyId);
    db.prepare('UPDATE companies SET name=?, notes=? WHERE id=?').run(
      one('SELECT 1 FROM companies WHERE name=? AND id<>?', data.company.name, companyId) ? one('SELECT name FROM companies WHERE id=?', companyId).name : data.company.name,
      data.company.notes || '', companyId);

    const profileMap = new Map();
    for (const p of data.profiles) {
      const id = db.prepare('INSERT INTO profiles (company_id, name, json, updated_at) VALUES (?,?,?,?)').run(companyId, p.name, p.json, p.updated_at).lastInsertRowid;
      profileMap.set(p.id, id);
    }
    for (const u of data.users) {
      if (one('SELECT 1 FROM users WHERE username=?', u.username)) { skipped.push(`usuario ${u.username} (el nombre ya lo usa otra cuenta)`); continue; }
      db.prepare('INSERT INTO users (username, salt, hash, role, company_id, created_at) VALUES (?,?,?,?,?,?)').run(u.username, u.salt, u.hash, u.role, companyId, u.created_at);
    }
    for (const d of data.devices) {
      if (one('SELECT 1 FROM devices WHERE id=? OR install_id=? OR token_hash=?', d.id, d.install_id, d.token_hash)) { skipped.push(`equipo ${d.name} (hoy pertenece a otra empresa)`); continue; }
      db.prepare(`INSERT INTO devices (id, company_id, token_hash, install_id, name, grp, notes, profile_id, blocked, block_title, block_message, app_overrides, state, public_ip, last_seen, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, companyId, d.token_hash, d.install_id, d.name, d.grp, d.notes, profileMap.get(d.profile_id) ?? null,
        d.blocked, d.block_title, d.block_message, d.app_overrides, d.state, d.public_ip, d.last_seen, d.created_at);
    }
    for (const t of data.enrollTokens) {
      if (one('SELECT 1 FROM enroll_tokens WHERE token=?', t.token)) { skipped.push(`token de alta ${t.label || t.token.slice(0, 4)}`); continue; }
      db.prepare('INSERT INTO enroll_tokens (token, company_id, label, profile_id, grp, uses, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(t.token, companyId, t.label, profileMap.get(t.profile_id) ?? null, t.grp, t.uses, t.max_uses, t.expires_at, t.created_at);
    }
    let missing = 0;
    for (const f of data.files) {
      const blob = path.join(filesDir, f.sha);
      const fromBackup = path.join(extracted.dir, 'files', f.sha);
      if (!fs.existsSync(blob)) {
        if (fs.existsSync(fromBackup)) fs.copyFileSync(fromBackup, blob);
        else { missing++; continue; }
      }
      db.prepare(`INSERT OR REPLACE INTO files (company_id, sha, kind, name, size, mime, package, version_code, version_name, parts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(companyId, f.sha, f.kind, f.name, f.size, f.mime, f.package, f.version_code, f.version_name, f.parts, f.created_at);
    }
    if (missing) skipped.push(`${missing} archivo(s) que el respaldo no traía`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { skipped, devices: data.devices.length, profiles: data.profiles.length, users: data.users.length, files: data.files.length };
}
