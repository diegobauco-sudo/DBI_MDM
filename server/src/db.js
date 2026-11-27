import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 2;

/**
 * Esquema 1 (v1.x): una sola organización.
 * Esquema 2 (multiempresa): empresas, usuarios con roles, todo lo demás con company_id.
 * Una base de la v1.x se migra sola al abrirse; si tenía datos, quedan en la empresa "Empresa principal".
 */
export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'wifly.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasV1 = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='admins'`).get();
  if (version < SCHEMA_VERSION) {
    if (hasV1) migrateFromV1(db);
    else createV2(db);
  }
  // Esquema 3: respaldos. Se agrega igual sobre bases nuevas y migradas.
  db.exec(BACKUP_TABLES);
  if (db.prepare('PRAGMA user_version').get().user_version < 3) db.exec('PRAGMA user_version = 3');
  // Esquema 4: datos fiscales de la empresa, datos de contacto de los usuarios, clientes y recuperación de clave.
  migrateV4(db);
  migrateV5(db);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

const BACKUP_TABLES = `
  CREATE TABLE IF NOT EXISTS backup_configs (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL, trigger TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, size INTEGER, filename TEXT,
    detail TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS backup_runs_key ON backup_runs(key, id);
`;

/** Agrega una columna solo si falta: sirve igual para bases nuevas, migradas desde la v1 o ya en esquema 3. */
function addColumns(db, table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of defs) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

function migrateV4(db) {
  db.exec('BEGIN');
  try {
    const text = "TEXT NOT NULL DEFAULT ''";
    addColumns(db, 'companies', [['legal_name', text], ['tax_address', text], ['tax_condition', text], ['tax_id', text], ['email', text], ['phone', text]]);
    addColumns(db, 'users', [['full_name', text], ['display_name', text], ['phone', text], ['email', text]]);
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        ext_id TEXT NOT NULL, name TEXT NOT NULL, tax_id TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (company_id, ext_id)
      );
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
      );
    `);
    addColumns(db, 'devices', [['client_id', 'INTEGER REFERENCES clients(id) ON DELETE SET NULL']]);
    addColumns(db, 'enroll_tokens', [['client_id', 'INTEGER REFERENCES clients(id) ON DELETE SET NULL']]);
    db.exec('CREATE INDEX IF NOT EXISTS devices_client ON devices(client_id)');
    if (db.prepare('PRAGMA user_version').get().user_version < 4) db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Roles del sistema (sin empresa) y de empresa. */
export const ROLES = ['superadmin', 'sysadmin', 'sysoperator', 'billing', 'admin', 'operator'];
const ROLE_LIST = ROLES.map((r) => `'${r}'`).join(',');

/**
 * Esquema 5: roles nuevos del sistema (administrador, operador y facturación) y empresas asignadas a cada operador.
 * SQLite no permite cambiar un CHECK: la tabla de usuarios se reconstruye con los mismos datos.
 */
function migrateV5(db) {
  const usersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get().sql;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!usersSql.includes("'sysoperator'")) {
      const cols = 'id, username, salt, hash, role, company_id, created_at, full_name, display_name, phone, email';
      db.exec(`
        CREATE TABLE users_v5 (
          id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN (${ROLE_LIST})),
          company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          full_name TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO users_v5 (${cols}) SELECT ${cols} FROM users;
        DROP TABLE users;
        ALTER TABLE users_v5 RENAME TO users;
      `);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS user_companies (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, company_id)
    )`);
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`La migración de usuarios dejó referencias inválidas: ${JSON.stringify(bad.slice(0, 3))}`);
    if (db.prepare('PRAGMA user_version').get().user_version < 5) db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const V2_TABLES = `
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    suspended_at INTEGER, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN (${ROLE_LIST})),
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (company_id, name)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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
  CREATE INDEX IF NOT EXISTS devices_company ON devices(company_id);
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
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sha TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
    package TEXT, version_code INTEGER, version_name TEXT, parts TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (company_id, sha)
  );
  CREATE INDEX IF NOT EXISTS files_sha ON files(sha);
  CREATE TABLE IF NOT EXISTS enroll_tokens (
    token TEXT PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '', profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    grp TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, company_id INTEGER, actor TEXT NOT NULL,
    action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS audit_company ON audit(company_id, id);
  -- Un registro por equipo y por día en que estuvo registrado: base de la facturación mensual.
  CREATE TABLE IF NOT EXISTS billing_days (
    company_id INTEGER NOT NULL, device_id TEXT NOT NULL, day TEXT NOT NULL, device_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (company_id, device_id, day)
  );
  CREATE INDEX IF NOT EXISTS billing_days_day ON billing_days(day);
  -- Meses cerrados: no cambian aunque después se den de alta o de baja equipos.
  CREATE TABLE IF NOT EXISTS billing_months (
    company_id INTEGER NOT NULL, month TEXT NOT NULL, devices INTEGER NOT NULL, closed_at INTEGER NOT NULL,
    PRIMARY KEY (company_id, month)
  );
`;

function createV2(db) {
  db.exec('BEGIN');
  try {
    db.exec(V2_TABLES);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrateFromV1(db) {
  // Las claves foráneas se apagan mientras se reconstruyen tablas; se vuelven a encender al final.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const now = Date.now();
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const filesCols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
    if (!filesCols.includes('parts')) db.exec('ALTER TABLE files ADD COLUMN parts TEXT');

    for (const t of ['profiles', 'devices', 'commands', 'files', 'enroll_tokens', 'audit', 'sessions']) {
      db.exec(`ALTER TABLE ${t} RENAME TO old_${t}`);
    }
    // Los índices viejos conservan su nombre aunque la tabla cambie: se borran para recrearlos en las tablas nuevas.
    db.exec('DROP INDEX IF EXISTS commands_device; DROP INDEX IF EXISTS commands_batch;');
    db.exec(V2_TABLES);

    const hadData = count('old_devices') + count('old_files') + count('old_enroll_tokens') > 0 || count('old_profiles') > 0;
    let cid = null;
    if (hadData) {
      cid = db.prepare(`INSERT INTO companies (name, created_at) VALUES ('Empresa principal', ?)`).run(now).lastInsertRowid;
    }
    // Los administradores de la v1 pasan a ser administradores generales.
    db.exec(`INSERT INTO users (username, salt, hash, role, company_id, created_at)
             SELECT username, salt, hash, 'superadmin', NULL, ${now} FROM admins`);

    if (cid) {
      db.exec(`INSERT INTO profiles (id, company_id, name, json, updated_at) SELECT id, ${cid}, name, json, updated_at FROM old_profiles`);
      db.exec(`INSERT INTO devices (id, company_id, token_hash, install_id, name, grp, notes, profile_id, blocked, block_title, block_message,
                 app_overrides, state, public_ip, last_seen, created_at)
               SELECT id, ${cid}, token_hash, install_id, name, grp, notes, profile_id, blocked, block_title, block_message,
                 app_overrides, state, public_ip, last_seen, created_at FROM old_devices`);
      db.exec(`INSERT INTO commands SELECT * FROM old_commands`);
      db.exec(`INSERT INTO files (company_id, sha, kind, name, size, mime, package, version_code, version_name, parts, created_at)
               SELECT ${cid}, sha, kind, name, size, mime, package, version_code, version_name, parts, created_at FROM old_files`);
      db.exec(`INSERT INTO enroll_tokens (token, company_id, label, profile_id, grp, uses, max_uses, expires_at, created_at)
               SELECT token, ${cid}, label, profile_id, grp, uses, max_uses, expires_at, created_at FROM old_enroll_tokens`);
      db.exec(`INSERT INTO audit (id, ts, company_id, actor, action, detail) SELECT id, ts, ${cid}, actor, action, detail FROM old_audit`);
    }
    // Las sesiones abiertas se descartan: todos vuelven a iniciar sesión una vez.
    for (const t of ['old_commands', 'old_devices', 'old_profiles', 'old_files', 'old_enroll_tokens', 'old_audit', 'old_sessions', 'admins']) {
      db.exec(`DROP TABLE ${t}`);
    }
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`La migración dejó referencias inválidas: ${JSON.stringify(bad.slice(0, 3))}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
