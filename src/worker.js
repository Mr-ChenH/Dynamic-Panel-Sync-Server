import { fileURLToPath } from 'node:url';
import { composeCli } from './cli/index.js';
import { BackupJob, DailyScheduler } from './jobs/index.js';

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

export async function startWorker(env = process.env, overrides = {}) {
  const hour = integerSetting(env, 'DP_BACKUP_HOUR_UTC', 2, 0, 23);
  const minute = integerSetting(env, 'DP_BACKUP_MINUTE_UTC', 0, 0, 59);
  const retrySeconds = integerSetting(env, 'DP_BACKUP_RETRY_SECONDS', 60, 1, 3600);
  const composed = await (overrides.composeCli ?? composeCli)(env, overrides);
  const job = new BackupJob({ backup: composed.cli.backup, jobs: composed.cli.repository });
  const reportError = overrides.reportError ?? ((error) => console.error(JSON.stringify({ component: 'backup-worker', code: error.code ?? 'BACKUP_FAILED', message: String(error.message).slice(0, 512) })));
  const scheduler = new DailyScheduler({ job, hour, minute, retryDelayMs: retrySeconds * 1000, onError: reportError, unrefTimers: false });
  let closing = false;
  let handleSignal;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await scheduler.stop();
    await composed.pool.end();
  };
  handleSignal = () => {
    void shutdown().catch(async (error) => { try { await reportError(error); } catch {} });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  scheduler.start({ immediate: true });
  return { job, scheduler, shutdown, composed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startWorker();
