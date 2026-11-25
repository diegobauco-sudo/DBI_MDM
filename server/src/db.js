import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'wifly.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      install_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      grp TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      block_title TEXT NOT NULL DEFAULT '',
      block_message TEXT NOT NULL DEFAULT '',
      app_overrides TEXT NOT NULL DEFAULT '{"add":[],"remove":[]}',
      state TEXT NOT NULL DEFAULT '{}',
      public_ip TEXT NOT NULL DEFAULT '',
      last_seen INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commands_device ON commands(device_id, status);
    CREATE INDEX IF NOT EXISTS commands_batch ON commands(batch_id);
    CREATE TABLE IF NOT EXISTS files (
      sha TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
      package TEXT, version_code INTEGER, version_name TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enroll_tokens (
      token TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
      grp TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
  `);
  // Migraciones de columnas agregadas después de la versión 1.0.
  const cols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
  if (!cols.includes('parts')) db.exec('ALTER TABLE files ADD COLUMN parts TEXT');
  return db;
}
