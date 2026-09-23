import { readFileSync } from 'node:fs';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required when DATABASE_PASSWORD_FILE is configured`);
  return value;
}

export function readSecretFile(file, name = 'secret') {
  if (typeof file !== 'string' || !file) throw new Error(`${name} file is required`);
  let value;
  try { value = readFileSync(file, 'utf8').replace(/[\r\n]+$/, ''); }
  catch (error) { throw new Error(`${name} file is unavailable`, { cause: error }); }
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${name} file must contain one non-empty line`);
  return value;
}

export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.DATABASE_PASSWORD_FILE) return undefined;

  const host = required(env, 'DATABASE_HOST');
  const user = required(env, 'DATABASE_USER');
  const database = required(env, 'DATABASE_NAME');
  const port = env.DATABASE_PORT ?? '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('DATABASE_PORT must be an integer between 1 and 65535');

  const endpoint = new URL('postgresql://localhost');
  endpoint.hostname = host;
  endpoint.port = port;
  const password = readSecretFile(env.DATABASE_PASSWORD_FILE, 'database password');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${endpoint.host}/${encodeURIComponent(database)}`;
}
