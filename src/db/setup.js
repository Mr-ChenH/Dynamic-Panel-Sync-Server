import { fileURLToPath } from 'node:url';
import { resolveDatabaseUrl, readSecretFile } from './connection-config.js';
import { migrate } from './migrate.js';
import { createPool } from './postgres.js';

const APP_ROLE = 'dynamic_panel_app';

async function roleCommand(pool, template, password) {
  const result = await pool.query(`SELECT format('${template}', $1::text) AS sql`, [password]);
  await pool.query(result.rows[0].sql);
}

export async function setupDatabase(env = process.env, overrides = {}) {
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) throw new Error('Administrative database connection is required');
  const appPassword = readSecretFile(env.DATABASE_APP_PASSWORD_FILE, 'application database password');
  const pool = (overrides.createPool ?? createPool)(databaseUrl);
  const migrateDatabase = overrides.migrate ?? migrate;

  try {
    const identity = await pool.query('SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!identity.rows[0]?.rolsuper) throw new Error('Database setup requires a PostgreSQL superuser');

    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (exists.rowCount) {
      await roleCommand(pool, `ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`, appPassword);
    } else {
      await roleCommand(pool, `CREATE ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L`, appPassword);
    }

    await migrateDatabase(pool);

    const databaseGrant = await pool.query(`SELECT format('GRANT CONNECT ON DATABASE %I TO ${APP_ROLE}', current_database()) AS sql`);
    await pool.query('BEGIN');
    try {
      await pool.query(databaseGrant.rows[0].sql);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
      await pool.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${APP_ROLE}`);
      await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE}`);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await setupDatabase();
