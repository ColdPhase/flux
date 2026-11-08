import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import { DEVICE_COOKIE_MAX_AGE_SECONDS, deviceCookieName, knows, readDevice, withAccount, writeDevice, type Device } from './device-cookie.js';

/**
 * The browsers an account remembers (#990, #1031). A device cookie (`device-cookie.ts`) names an account by a keyed hash of its address
 * and its **device generation**, a number on the account that a password reset and "Sign out all other devices" raise. A copy of the cookie
 * that was taken before then names an older generation, so it stops counting as that browser; the browser that did the reset or the
 * sign-out is given a cookie with the new one at once.
 *
 * A cookie is only ever written for the generation the writer's own raise produced (`endAll` returns it), never for one read afterwards:
 * between a raise and a later read another request may have raised it again, and a cookie for that value would count after a reset that
 * came in between (#1067).
 */
export interface Devices {
  /** The cookie's name and options (`Secure` over HTTPS), for whoever sets it. */
  cookie: { name: string; options: { maxAge: number; httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/' } };
  /** The device a cookie value names when it is signed by this server and lists this account at its current generation; else null. */
  known(value: string | null | undefined, email: string): Promise<Device | null>;
  /**
   * What "Sign out all other devices" looks at first: the device the cookie names if it counts now, and the generation that was seen.
   * Both come from one reading, so `endAll` can raise exactly that generation.
   */
  check(value: string | null | undefined, email: string, userId: string): Promise<{ device: Device | null; seen: number }>;
  /**
   * The cookie value that remembers this account for the browser that sent `value`, if any (its older keys taken out). `generation` is the
   * one the caller's own `endAll` returned; without it, the account's current generation is read.
   */
  remember(value: string | null | undefined, email: string, generation?: number): Promise<string>;
  /**
   * Every cookie given out so far stops counting as a browser of this account: the generation is raised and the new one returned.
   * With `only`, the raise happens only if the generation is still `seen` and the session is still there (a revoked session raises nothing),
   * and the answer is null when it did not: someone else raised it meanwhile, which ended the same cookies, and the caller gives no cookie.
   */
  endAll(userId: string, only?: { seen: number; sessionId: string }): Promise<number | null>;
}

/** How many older generations of an account's key `remember` takes out of a cookie; a key older than that stays until newer accounts push it out. */
const OLDER_GENERATIONS = 16;

export function createDevices(db: Database, secret: string, secure: boolean): Devices {
  const address = (email: string) => email.trim().toLowerCase();
  const generation = schema.authUsers.deviceGeneration;
  // An address nobody holds has generation 0: a cookie can only name an account it signed in to.
  const generationOf = async (email: string) => {
    const [row] = await db.select({ generation }).from(schema.authUsers).where(sql`lower(${schema.authUsers.email}) = ${address(email)}`);
    return row?.generation ?? 0;
  };
  const keyAt = (email: string, at: number) => createHmac('sha256', secret)
    .update('flux-device-account\0').update(address(email)).update('\0').update(String(at)).digest('hex').slice(0, 16);
  // The key of this account at a generation, and of its last few older ones, which a cookie may still list and `remember` takes out of it.
  const keysAt = (email: string, at: number) => ({ current: keyAt(email, at),
    older: Array.from({ length: Math.min(at, OLDER_GENERATIONS) }, (_, back) => keyAt(email, at - 1 - back)) });
  return {
    cookie: { name: deviceCookieName(secure), options: { maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS, httpOnly: true, sameSite: 'lax', secure, path: '/' } },
    async known(value, email) {
      const device = readDevice(secret, value);
      return device && knows(device, keyAt(email, await generationOf(email))) ? device : null;
    },
    async check(value, email, userId) {
      const [row] = await db.select({ generation }).from(schema.authUsers).where(eq(schema.authUsers.id, userId));
      const seen = row?.generation ?? 0;
      const device = readDevice(secret, value);
      return { device: device && knows(device, keyAt(email, seen)) ? device : null, seen };
    },
    async remember(value, email, at) {
      const { current, older } = keysAt(email, at ?? await generationOf(email));
      return writeDevice(secret, withAccount(readDevice(secret, value), current, older));
    },
    async endAll(userId, only) {
      const where = only
        ? and(eq(schema.authUsers.id, userId), eq(generation, only.seen),
          sql`EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = ${only.sessionId} AND s.user_id = ${userId})`)
        : eq(schema.authUsers.id, userId);
      const [row] = await db.update(schema.authUsers).set({ deviceGeneration: sql`${generation} + 1` }).where(where).returning({ generation });
      return row?.generation ?? null;
    },
  };
}
