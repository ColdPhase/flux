import { RateLimitedError } from '@flux/core';

/**
 * A per-user rolling-window limit on live join grants (#62). It lives in one API process:
 * created in the composition root and passed in, so N API instances allow N times the limit.
 * That is a cheap guard against a runaway client, not a security boundary; admission itself
 * is decided by the live use cases. Memory is bounded: each person keeps at most `limit`
 * timestamps, expired people are pruned, and beyond `maxUsers` the oldest entries go first.
 */
export interface JoinRateLimiter {
  /** Counts one attempt, or throws `LIVE_JOIN_RATE_LIMITED` with the seconds until one frees up. */
  take(userId: string): void;
  /** Tracked people, for tests and diagnostics. */
  size(): number;
}

export interface JoinRateLimitOptions {
  limit?: number;
  windowMs?: number;
  maxUsers?: number;
  now?: () => number;
}

export const LIVE_JOIN_RATE_LIMIT = { limit: 20, windowMs: 60_000, maxUsers: 10_000 } as const;

export function joinRateLimiter(options: JoinRateLimitOptions = {}): JoinRateLimiter {
  const limit = options.limit ?? LIVE_JOIN_RATE_LIMIT.limit;
  const windowMs = options.windowMs ?? LIVE_JOIN_RATE_LIMIT.windowMs;
  const maxUsers = options.maxUsers ?? LIVE_JOIN_RATE_LIMIT.maxUsers;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(limit) || limit < 1 || !(windowMs > 0) || !Number.isInteger(maxUsers) || maxUsers < 1)
    throw new Error('Invalid live join rate limit');
  // Insertion order doubles as least-recently-used order: a person is re-inserted on each take.
  const attempts = new Map<string, number[]>();

  const prune = (at: number) => {
    for (const [userId, times] of attempts) {
      if (times[times.length - 1]! <= at - windowMs) attempts.delete(userId);
    }
    while (attempts.size >= maxUsers) attempts.delete(attempts.keys().next().value!);
  };

  return {
    take(userId) {
      const at = now();
      const times = (attempts.get(userId) ?? []).filter((time) => time > at - windowMs);
      attempts.delete(userId);
      if (times.length >= limit) {
        attempts.set(userId, times);
        const retryAfterSeconds = Math.max(1, Math.ceil((times[0]! + windowMs - at) / 1000));
        throw new RateLimitedError(retryAfterSeconds, 'Too many join attempts; try again shortly', 'LIVE_JOIN_RATE_LIMITED');
      }
      if (attempts.size >= maxUsers) prune(at);
      times.push(at);
      attempts.set(userId, times);
    },
    size: () => attempts.size,
  };
}
