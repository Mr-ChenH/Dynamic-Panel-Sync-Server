import { assessBackupJobHealth } from './backup-health.js';

function clone(value) { return structuredClone(value); }

export class MemoryOperationsRepository {
  constructor({ identityStore, usage = [], components = [{ name: 'database', status: 'ok' }], migrations = [] } = {}) {
    this.identityStore = identityStore;
    this.usageRows = usage;
    this.components = components;
    this.migrations = migrations;
    this.limits = new Map();
    this.backupJobs = new Map();
    this.backupAlerts = [];
    this.nextBackupJobId = 1;
  }
  async getLimits(accountId) { return clone(this.limits.get(accountId) ?? { accountId, activeSpaces: 10, activeClientsPerSpace: 10 }); }
  async setLimits(accountId, limits) {
    if (!Number.isInteger(limits.activeSpaces) || limits.activeSpaces < 1 || limits.activeSpaces > 10 || !Number.isInteger(limits.activeClientsPerSpace) || limits.activeClientsPerSpace < 1 || limits.activeClientsPerSpace > 10) {
      throw Object.assign(new Error('Limits must be integers from 1 through 10'), { code: 'INVALID_ARGUMENT' });
    }
    const row = { accountId, ...limits }; this.limits.set(accountId, row); return clone(row);
  }
  async usage(accountId, spaceId) { return clone(this.usageRows.filter((row) => (!accountId || row.accountId === accountId) && (!spaceId || row.spaceId === spaceId))); }
  async audit(accountId, filters) { return this.identityStore?.listAudit(accountId, filters) ?? []; }
  async queueBackupJob(job) {
    const jobId = `backup-job-${this.nextBackupJobId++}`;
    this.backupJobs.set(jobId, { jobId, ...clone(job) });
    return jobId;
  }
  async startBackupJob(jobId, job) { if (jobId) this.backupJobs.set(jobId, { ...this.backupJobs.get(jobId), ...clone(job), jobId }); }
  async finishBackupJob(jobId, job) {
    if (jobId) this.backupJobs.set(jobId, { ...this.backupJobs.get(jobId), ...clone(job), jobId });
    this.backupAlerts = [];
  }
  async failBackupJob(jobId, job) {
    if (jobId) this.backupJobs.set(jobId, { ...this.backupJobs.get(jobId), ...clone(job), jobId });
    this.backupAlerts = [{ code: 'scheduled_backup_failed', severity: 'critical', details: { jobId: jobId ?? null, errorCode: job.errorCode }, firstSeenAt: job.completedAt, lastSeenAt: job.completedAt }];
  }
  async backupHealth(options) {
    const latestJob = [...this.backupJobs.values()].at(-1) ?? null;
    const lastVerifiedJob = [...this.backupJobs.values()].reverse().find((job) => job.status === 'verified') ?? null;
    return clone(assessBackupJobHealth({ latestJob, lastVerifiedJob, alerts: this.backupAlerts }, options));
  }
  async migrationStatus() { return { applied: clone(this.migrations) }; }
  async health() { return clone(this.components); }
}
