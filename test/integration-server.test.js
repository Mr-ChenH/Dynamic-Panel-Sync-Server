import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as cliMain } from '../src/cli/index.js';
import { loadConfig } from '../src/config.js';
import { buildServer, startServer } from '../src/server.js';

const SECRET = 'integration-secret-with-at-least-32-bytes';
const config = () => loadConfig({ NODE_ENV: 'test', COOKIE_SECRET: SECRET, KEY_LOOKUP_SECRET: `${SECRET}-lookup`, CURSOR_SECRET: `${SECRET}-cursor` });

function serviceSection(compose, name, next) {
  return compose.slice(compose.indexOf(`  ${name}:`), compose.indexOf(`\n  ${next}:`));
}

function assertProductionTopology(compose) {
  const setup = serviceSection(compose, 'database-setup', 'sync-server');
  const server = serviceSection(compose, 'sync-server', 'backup-worker');
  const worker = compose.slice(compose.indexOf('  backup-worker:'), compose.indexOf('\nvolumes:'));
  assert.equal(compose.split('/var/lib/dynamic-panel/objects').length - 1, 1);
  assert.equal(compose.split('/var/lib/dynamic-panel/backups').length - 1, 1);
  assert.equal(compose.match(/environment: \*runtime_environment/g)?.length, 2);
  assert.equal(compose.match(/<<: \*app_defaults/g)?.length, 3);
  assert.match(compose, /POSTGRES_USER: dynamic_panel_admin/);
  assert.match(compose, /DATABASE_USER: dynamic_panel_app/);
  assert.match(setup, /command: \["node", "src\/db\/setup\.js"\]/);
  assert.match(setup, /postgres_admin_password/);
  assert.match(server, /database-setup:\s+condition: service_completed_successfully/);
  assert.match(server, /command: \["node", "src\/server\.js"\]/);
  assert.doesNotMatch(server, /postgres_admin_password/);
  assert.match(worker, /command: \["node", "src\/worker\.js"\]/);
  assert.match(worker, /source: object-data\s+target: \*object_path\s+read_only: true/);
  assert.match(worker, /source: backup-data\s+target: \*backup_path/);
  assert.match(worker, /healthcheck:\s+disable: true/);
  assert.match(worker, /sync-server:\s+condition: service_healthy/);
  assert.doesNotMatch(compose, /npm run|"sh", "-c"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /user: "10001:10001"/);
  assert.match(compose, /DP_BACKUP_MASTER_KEY_FILE: \/run\/secrets\/backup_master_key/);
  assert.match(compose, /postgres_admin_password:\s+environment: DP_POSTGRES_ADMIN_PASSWORD/);
  assert.match(compose, /postgres_app_password:\s+environment: DP_POSTGRES_APP_PASSWORD/);
  assert.match(compose, /backup_master_key:\s+environment: DP_BACKUP_MASTER_KEY/);
  assert.match(server, /source: backup_master_key\s+target: backup_master_key\s+uid: "10001"\s+gid: "10001"\s+mode: 0400/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s+- ALL/);
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /published: \$\{DP_BIND_PORT:-43822\}/);
  assert.match(compose, /host_ip: \$\{DP_BIND_ADDRESS:-127\.0\.0\.1\}/);
}

test('composed server injects health and strict-CSP console assets', async (t) => {
  const app = await buildServer({ config: config(), logger: false });
  t.after(() => app.close());
  const health = await app.inject({ url: '/api/v1/health/ready' });
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().data.status, 'ok');

  const consolePage = await app.inject({ url: '/console/login' });
  assert.equal(consolePage.statusCode, 200);
  assert.match(consolePage.headers['content-security-policy'], /default-src 'self'/);
  assert.match(consolePage.headers['content-security-policy'], /object-src 'none'/);
  assert.match(consolePage.body, /\/console\/app\.js/);

  const script = await app.inject({ url: '/console/app.js' });
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'], /text\/javascript/);
});

test('backup operations migration forces admin-only RLS on every management table', async () => {
  const migration = await readFile(new URL('../migrations/0006_backup_operations_rls.sql', import.meta.url), 'utf8');
  const tables = ['backup_jobs', 'restore_stages', 'restore_stage_payloads', 'restore_stage_objects', 'operational_alerts'];
  for (const table of tables) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_admin ON ${table}\\s+USING \\(operational_admin_allowed\\(\\)\\) WITH CHECK \\(operational_admin_allowed\\(\\)\\);`));
  }
  assert.doesNotMatch(migration, /current_setting\('app\.account_id'/);
});

test('readiness exposes backup health as a distinct component', async (t) => {
  const app = await buildServer({
    config: config(),
    logger: false,
    readiness: { database: async () => 'ok', objects: async () => 'ok', backup: async () => 'degraded' }
  });
  t.after(() => app.close());
  const response = await app.inject({ url: '/api/v1/health/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { status: 'degraded', components: { database: 'ok', objects: 'ok', backup: 'degraded' } });
});

test('source-build production topology is hardened and gates runtime services on database setup', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [compose, dockerfile] = await Promise.all([
    readFile(path.join(root, 'compose.example.yml'), 'utf8'),
    readFile(path.join(root, 'Dockerfile'), 'utf8')
  ]);
  assertProductionTopology(compose);
  assert.match(dockerfile, /useradd --uid 10001 --gid dynamic-panel/);
  assert.match(dockerfile, /USER dynamic-panel/);
  assert.equal(compose.match(/^  build: \.$/gm)?.length, 1);
  assert.equal(compose.match(/^  image: dynamic-panel-sync-server:local$/gm)?.length, 1);
  assert.doesNotMatch(compose, /ghcr\.io/);
});

test('registry production topology pulls one shared published image without a local build', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const compose = await readFile(path.join(root, 'compose.image.yml'), 'utf8');
  assertProductionTopology(compose);
  assert.equal(compose.match(/image: \$\{DP_SYNC_IMAGE:-ghcr\.io\/mr-chenh\/dynamic-panel-sync-server:latest\}/g)?.length, 1);
  assert.equal(compose.match(/pull_policy: always/g)?.length, 1);
  assert.doesNotMatch(compose, /^\s+build:/m);
});

test('account sessions and ClientKey credentials cannot cross route families', async (t) => {
  const app = await buildServer({ config: config(), logger: false });
  t.after(() => app.close());
  const accountWithClientKey = await app.inject({ url: '/api/v1/account/session', headers: { authorization: 'ClientKey dpk_v1_not-a-real-key' } });
  assert.equal(accountWithClientKey.statusCode, 401);
  const syncWithCookie = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { cookie: 'dp_session=not-a-client-key' }, payload: { operations: [] } });
  assert.equal(syncWithCookie.statusCode, 400);
  assert.notEqual(syncWithCookie.json().error?.code, undefined);
});

test('production config rejects missing infrastructure and shared local data roots', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://db/app', CONSOLE_ORIGIN: 'https://sync.example.com', TRUST_PROXY: '127.0.0.1', COOKIE_SECRET: SECRET, KEY_LOOKUP_SECRET: `${SECRET}-lookup`, CURSOR_SECRET: `${SECRET}-cursor`, DP_BACKUP_TARGET: 'filesystem', DP_BACKUP_MASTER_KEY: Buffer.alloc(32).toString('base64'), DP_OBJECT_TARGET: 'filesystem' };
  assert.throws(() => loadConfig({ ...base, DP_OBJECT_PATH: '/data/same', DP_BACKUP_PATH: '/data/same' }), /must be separate/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: undefined, DP_OBJECT_PATH: '/data/objects', DP_BACKUP_PATH: '/data/backups' }), /DATABASE_URL/);
});

test('CLI help requires no database and server start-stop drains cleanly', async () => {
  let output = '';
  assert.equal(await cliMain(['--help'], {}, { stdout: (value) => { output += value; } }), 0);
  assert.match(output, /backup run\|list\|verify/);

  const runtime = await startServer({ config: { ...config(), host: '127.0.0.1', port: 0 }, logger: false, signals: [] });
  assert.equal(runtime.app.server.listening, true);
  await runtime.shutdown();
  assert.equal(runtime.app.server.listening, false);
});
