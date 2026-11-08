import { createHmac } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';

/**
 * The account's own back-off against password guessing (#990, OWASP ASVS 4.0.3 V2.2.1). Better Auth's limiter counts requests per client
 * address, so guesses spread over many addresses were never slowed; this counts per account, in PostgreSQL, so every API process shares one count.
 *
 * Every password sign-in attempt is counted before the password is checked (so parallel attempts cannot all pass a stale count), and a
 * sign-in that succeeds clears the count. Five attempts in a row cost nothing; after the fifth the account refuses sign-in for 30 seconds,
 * then after the sixth for 1 minute, then 2, 4 and 8, and at most 15 minutes from the tenth on. A count is forgotten after an hour without
 * an attempt, and a password reset clears it.
 *
 * A stranger could use that wait to keep a person out (a wrong guess whenever it ends), so the wait is not for a browser that has signed in
 * to the account before: it carries a signed device cookie (`device-cookie.ts`) and counts in a wait of its own. The browser that
 * finishes a password reset gets the cookie too, so the reset really is the way back. What a stranger can still keep waiting is a browser
 * that has never signed in to that account, for the same window, and the answer does not say how long.
 * An address nobody holds is counted and slowed exactly like a real one, so the answer does not say which addresses have accounts.
 */
export const SIGN_IN_ATTEMPTS_BEFORE_WAIT = 5;
const FIRST_WAIT_SECONDS = 30;
const LONGEST_WAIT_SECONDS = 900;
const FORGET_AFTER_SECONDS = 3600;

/** Seconds the account refuses the next sign-in after this many attempts in a row (0 before the fifth). */
export function waitAfterAttempts(attempts: number): number {
  if (attempts < SIGN_IN_ATTEMPTS_BEFORE_WAIT) return 0;
  return Math.min(LONGEST_WAIT_SECONDS, FIRST_WAIT_SECONDS * 2 ** (attempts - SIGN_IN_ATTEMPTS_BEFORE_WAIT));
}

export interface SignInThrottle {
  /**
   * Counts one password sign-in attempt for the address. Returns the seconds the account still refuses sign-in (the attempt is then not
   * counted), or 0 when the attempt may go on and be checked against the password. With `device`, the browser has signed in to this
   * account before (a valid device cookie, `device-cookie.ts`) and the attempt is counted in the wait of this account on this browser
   * alone: a stranger's guesses never lock it out, and its own guesses never lock the account for anyone else.
   */
  attempt(email: string, device?: string): Promise<number>;
  /** The address signed in or reset its password: the count (of this browser, with `device`) starts again. */
  clear(email: string, device?: string): Promise<void>;
  /** The key of an address in the cookie of a device. */
  accountKey(email: string): string;
}

export function createSignInThrottle(db: Database, secret: string): SignInThrottle {
  const t = schema.authSignInThrottle;
  const address = (email: string) => email.trim().toLowerCase();
  const key = (email: string, device?: string) => createHmac('sha256', secret)
    .update(device ? 'flux-sign-in-throttle-device\0' : 'flux-sign-in-throttle\0').update(address(email)).update(device ? `\0${device}` : '').digest('hex');
  return {
    accountKey: (email) => createHmac('sha256', secret).update('flux-device-account\0').update(address(email)).digest('hex').slice(0, 16),
    async attempt(email, device) {
      const accountHash = key(email, device);
      return db.transaction(async (tx) => {
        // The database clock decides, so API processes with different clocks agree.
        const [{ ms }] = (await tx.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`)).rows;
        const now = new Date(Number(ms));
        await tx.insert(t).values({ accountHash, failures: 0, lastFailureAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(t).where(eq(t.accountHash, accountHash)).for('update');
        if (row.lockedUntil && row.lockedUntil > now) return Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000);
        const forgotten = now.getTime() - row.lastFailureAt.getTime() > FORGET_AFTER_SECONDS * 1000;
        const attempts = (forgotten ? 0 : row.failures) + 1;
        const wait = waitAfterAttempts(attempts);
        await tx.update(t).set({ failures: attempts, lastFailureAt: now, lockedUntil: wait ? new Date(now.getTime() + wait * 1000) : null }).where(eq(t.accountHash, accountHash));
        // Counts nobody comes back to do not pile up: drop what is past the forgetting time (an index range scan).
        const forgetting = new Date(now.getTime() - FORGET_AFTER_SECONDS * 1000);
        await tx.delete(t).where(lt(t.lastFailureAt, forgetting));
        // Better Auth's own per-address counts are not pruned between sign-ins either: the rows past its longest window go too.
        await tx.delete(schema.authRateLimits).where(lt(schema.authRateLimits.lastRequest, forgetting.getTime()));
        return 0;
      });
    },
    async clear(email, device) {
      await db.delete(t).where(eq(t.accountHash, key(email, device)));
    },
  };
}
