import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { readSecretFile, resolveDatabaseUrl } from '../src/db/connection-config.js';
import { setupDatabase } from '../src/db/setup.js';

const SECRET = 'integration-secret-with-at-least-32-bytes';

async function passwordFixture(t, password = 'p@ ss:/?#[]%word') {
  const root = await mkdtemp(path.join(tmpdir(), 'dp-database-config-'));
  const file = path.join(root, 'password');
  await writeFile(file, `${password}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { file, password };
}

test('database password files produce encoded connection URLs without changing direct URL support', async (t) => {
  const fixture = await passwordFixture(t);
  const env = {
    DATABASE_HOST: 'postgres', DATABASE_PORT: '5432', DATABASE_NAME: 'dynamic panel',
    DATABASE_USER: 'dynamic_panel_app', DATABASE_PASSWORD_FILE: fixture.file
  };
  const url = new URL(resolveDatabaseUrl(env));
  assert.equal(url.hostname, 'postgres');
  assert.equal(url.port, '5432');
  assert.equal(url.username, 'dynamic_panel_app');
  assert.equal(decodeURIComponent(url.password), fixture.password);
  assert.equal(decodeURIComponent(url.pathname), '/dynamic panel');
  assert.equal(resolveDatabaseUrl({ ...env, DATABASE_URL: 'postgresql://direct/db', DATABASE_PASSWORD_FILE: 'missing' }), 'postgresql://direct/db');
  assert.equal(readSecretFile(fixture.file, 'test password'), fixture.password);
});

test('production config accepts a database password file connection', async (t) => {
  const fixture = await passwordFixture(t, 'database-password-with-special-@-character');
  const config = loadConfig({
    NODE_ENV: 'production', CONSOLE_ORIGIN: 'https://sync.example.com', TRUST_PROXY: 'loopback,uniquelocal',
    COOKIE_SECRET: SECRET, KEY_LOOKUP_SECRET: `${SECRET}-lookup`, CURSOR_SECRET: `${SECRET}-cursor`,
    DATABASE_HOST: 'postgres', DATABASE_NAME: 'dynamic_panel', DATABASE_USER: 'dynamic_panel_app', DATABASE_PASSWORD_FILE: fixture.file,
    DP_OBJECT_TARGET: 'filesystem', DP_OBJECT_PATH: '/data/objects', DP_BACKUP_TARGET: 'filesystem', DP_BACKUP_PATH: '/data/backups',
    DP_BACKUP_MASTER_KEY: Buffer.alloc(32).toString('base64')
  });
  assert.equal(new URL(config.databaseUrl).username, 'dynamic_panel_app');
  assert.equal(decodeURIComponent(new URL(config.databaseUrl).password), 'database-password-with-special-@-character');
});

test('database setup creates a non-superuser runtime role before migration and grants only data access', async (t) => {
  const admin = await passwordFixture(t, 'admin-password');
  const app = await passwordFixture(t, 'app-password');
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT current_user')) return { rows: [{ role: 'dynamic_panel_admin', rolsuper: true }], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM pg_roles')) return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT format('CREATE ROLE")) return { rows: [{ sql: 'CREATE ROLE dynamic_panel_app WITH LOGIN NOSUPERUSER' }], rowCount: 1 };
      if (sql.startsWith("SELECT format('GRANT CONNECT")) return { rows: [{ sql: 'GRANT CONNECT ON DATABASE dynamic_panel TO dynamic_panel_app' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() { calls.push({ sql: 'END_POOL', params: [] }); }
  };
  let migratedAt = -1;
  await setupDatabase({
    DATABASE_HOST: 'postgres', DATABASE_NAME: 'dynamic_panel', DATABASE_USER: 'dynamic_panel_admin',
    DATABASE_PASSWORD_FILE: admin.file, DATABASE_APP_PASSWORD_FILE: app.file
  }, {
    createPool: () => pool,
    migrate: async () => { migratedAt = calls.length; calls.push({ sql: 'MIGRATE', params: [] }); }
  });

  const sql = calls.map((entry) => entry.sql);
  assert.ok(sql.indexOf('CREATE ROLE dynamic_panel_app WITH LOGIN NOSUPERUSER') < migratedAt);
  assert.ok(sql.indexOf('MIGRATE') < sql.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dynamic_panel_app'));
  assert.ok(sql.includes('REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM dynamic_panel_app'));
  assert.ok(sql.includes('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO dynamic_panel_app'));
  assert.equal(sql.at(-1), 'END_POOL');
});
