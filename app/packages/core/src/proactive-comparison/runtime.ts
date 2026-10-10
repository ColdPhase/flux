/**
 * The operator switch for background comparisons (#58, O-007): `FLUX_BACKGROUND_COMPARISONS=on`
 * lets owners enable their comparison rules (API) and registers the comparison scheduling,
 * dispatch and recovery jobs (worker). Empty or `off`, the default, keeps every rule paused and
 * the jobs unregistered. Any other value stops the app at startup, like `FLUX_PERSONAL_RUNS`.
 */
export function backgroundComparisonsEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.FLUX_BACKGROUND_COMPARISONS ?? '';
  if (value === 'on') return true;
  if (value === '' || value === 'off') return false;
  throw new Error('FLUX_BACKGROUND_COMPARISONS must be empty, off or on');
}

/** Every minute: collect source changes, reconsider enabled projects, dispatch what is ready. */
export const COMPARISON_TICK_JOB = 'proactive.comparison.tick.v1';
/** Every ten minutes: settle reservations a crash or a lost answer left open. */
export const COMPARISON_RECOVERY_JOB = 'proactive.comparison.recovery.v1';
/**
 * One tick at a time across workers (`singleton`); a failed tick is not retried, the next scheduled
 * one runs. Dispatch itself is safe to repeat: each candidate is reserved before any provider call.
 * A live worker heartbeats while it works a job; a killed worker's job is failed within about
 * `heartbeatSeconds` plus one pg-boss supervise pass (60 s), so the singleton queue resumes within
 * minutes, not at the one-hour expiry (#58).
 */
export const COMPARISON_JOB_RETRY = { retryLimit: 0, expireInSeconds: 3600, heartbeatSeconds: 30, deleteAfterSeconds: 24 * 3600 };
export const COMPARISON_JOB_QUEUE = { policy: 'singleton' as const, ...COMPARISON_JOB_RETRY };
