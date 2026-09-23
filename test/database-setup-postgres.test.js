import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { resolveDatabaseUrl } from '../src/db/connection-config.js';
import { setupDatabase } from '../src/db/setup.js';

const adminUrl = process.env.SYNC_SETUP_DATABASE_URL;
const appPassword = process.env.SYNC_SETUP_APP_PASSWORD;

test('PostgreSQL setup is idempotent and the runtime role cannot bypass tenant RLS', { skip: !adminUrl || !appPassword }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dp-database-setup-'));
  const appPasswordFile = path.join(root, 'app-password');
  await writeFile(appPasswordFile, `${appPassword}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  await setupDatabase({ DATABASE_URL: adminUrl, DATABASE_APP_PASSWORD_FILE: appPasswordFile });
  await setupDatabase({ DATABASE_URL: adminUrl, DATABASE_APP_PASSWORD_FILE: appPasswordFile });

  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  t.after(() => admin.end());
  const endpoint = new URL(adminUrl);
  const runtimeUrl = resolveDatabaseUrl({
    DATABASE_HOST: endpoint.hostname,
    DATABASE_PORT: endpoint.port || '5432',
    DATABASE_NAME: endpoint.pathname.slice(1),
    DATABASE_USER: 'dynamic_panel_app',
    DATABASE_PASSWORD_FILE: appPasswordFile
  });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 2 });
  t.after(() => runtime.end());

  const role = (await admin.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='dynamic_panel_app'")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
  assert.equal((await runtime.query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed")).rows[0].allowed, false);
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user, 'schema_migrations', 'INSERT') AS allowed")).rows[0].allowed, false);
  assert.equal((await admin.query('SELECT count(*)::integer AS count FROM schema_migrations')).rows[0].count, 6);

  const accountId = randomUUID();
  const spaceId = randomUUID();
  await admin.query('INSERT INTO accounts(account_id,username,normalized_username,password_hash) VALUES($1,$2,$2,$3)', [accountId, `setup-${accountId}`, 'not-a-real-password-hash']);
  await admin.query('INSERT INTO spaces(account_id,space_id,name,normalized_name) VALUES($1,$2,$3,$3)', [accountId, spaceId, 'Setup verification']);

  assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM spaces WHERE space_id=$1', [spaceId])).rows[0].count, 0);
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.account_id',$1,true)", [accountId]);
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM spaces WHERE space_id=$1', [spaceId])).rows[0].count, 1);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
