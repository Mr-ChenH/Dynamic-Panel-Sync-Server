export class BackupJob {
  constructor({ backup, jobs = null, clock = () => new Date() }) { this.backup = backup; this.jobs = jobs; this.clock = clock; }

  async run({ prune = true, scope, reason = 'scheduled' } = {}) {
    const queued = { type: 'backup', status: 'queued', createdAt: this.clock().toISOString(), reason, scope };
    let jobId;
    try {
      jobId = await this.jobs?.queueBackupJob?.(queued);
      const running = { ...queued, status: 'running', startedAt: this.clock().toISOString() };
      await this.jobs?.startBackupJob?.(jobId, running);
      const point = await this.backup.create({ scope, reason });
      let retention = null;
      if (prune) retention = await this.backup.prune();
      const result = { ...running, status: 'verified', completedAt: this.clock().toISOString(), point, retention };
      await this.jobs?.finishBackupJob?.(jobId, result);
      return result;
    } catch (error) {
      const result = { ...queued, status: 'failed', completedAt: this.clock().toISOString(), errorCode: error.code ?? 'BACKUP_FAILED' };
      try { await this.jobs?.failBackupJob?.(jobId, result); } catch (persistenceError) { error.persistenceError = persistenceError; }
      throw error;
    }
  }
}

export class DailyScheduler {
  constructor({ job, hour = 2, minute = 0, retryDelayMs = 60_000, clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, onError = async () => {}, unrefTimers = true }) {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1) throw new RangeError('retryDelayMs must be a positive integer');
    this.job = job; this.hour = hour; this.minute = minute; this.retryDelayMs = retryDelayMs; this.clock = clock; this.setTimer = setTimer; this.clearTimer = clearTimer; this.onError = onError; this.unrefTimers = unrefTimers; this.timer = null; this.running = false; this.stopped = true; this.currentRun = null;
  }
  nextRun(now = this.clock()) {
    const next = new Date(now); next.setUTCHours(this.hour, this.minute, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  arm(delay) {
    this.timer = this.setTimer(() => { this.timer = null; void this.runOnce(); }, delay);
    if (this.unrefTimers) this.timer?.unref?.();
  }
  schedule() {
    const now = this.clock();
    const next = this.nextRun(now);
    this.arm(next.getTime() - now.getTime());
    return next;
  }
  scheduleRetry() {
    this.arm(this.retryDelayMs);
  }
  start({ immediate = false } = {}) {
    this.stopped = false;
    if (immediate) { void this.runOnce(); return this.nextRun(); }
    return this.schedule();
  }
  async runOnce() {
    if (this.running || this.stopped) return this.currentRun;
    this.running = true;
    this.currentRun = (async () => {
      let succeeded = false;
      try { await this.job.run(); succeeded = true; }
      catch (error) { try { await this.onError(error); } catch {} }
      finally {
        this.running = false;
        if (!this.stopped) {
          if (succeeded) this.schedule();
          else this.scheduleRetry();
        }
      }
    })();
    await this.currentRun;
    this.currentRun = null;
  }
  async stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.currentRun;
  }
}
