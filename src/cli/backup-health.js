export const BACKUP_ACTIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const BACKUP_VERIFIED_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const ACTIVE_STATES = new Set(['queued', 'running', 'verifying']);

function age(now, value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? now.getTime() - timestamp : Number.POSITIVE_INFINITY;
}

export function assessBackupJobHealth({ latestJob = null, lastVerifiedJob = null, alerts = [] }, {
  now = new Date(),
  activeMaximumAgeMs = BACKUP_ACTIVE_MAX_AGE_MS,
  verifiedMaximumAgeMs = BACKUP_VERIFIED_MAX_AGE_MS
} = {}) {
  const derived = [];
  if (!latestJob) {
    derived.push({ code: 'backup_job_missing', severity: 'critical', message: 'No scheduled backup job has been recorded.' });
  } else if (ACTIVE_STATES.has(latestJob.status) && age(now, latestJob.startedAt ?? latestJob.createdAt) > activeMaximumAgeMs) {
    derived.push({ code: 'backup_job_stale', severity: 'critical', message: 'The latest backup job has not completed within the expected time.' });
  } else if (latestJob.status === 'failed') {
    derived.push({ code: 'backup_job_failed', severity: 'critical', message: 'The latest backup job failed.' });
  }
  if (lastVerifiedJob && age(now, lastVerifiedJob.completedAt ?? lastVerifiedJob.createdAt) > verifiedMaximumAgeMs) {
    derived.push({ code: 'backup_verified_stale', severity: 'critical', message: 'The last verified backup job is too old.' });
  }
  const combined = [...alerts, ...derived];
  return { status: combined.length ? 'degraded' : 'ok', latestJob, lastVerifiedJob, alerts: combined };
}
