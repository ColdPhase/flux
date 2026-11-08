import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import { DEVICE_COOKIE_MAX_AGE_SECONDS, deviceCookieName, knows, readDevice, withAccount, writeDevice, type Device } from './device-cookie.js';

/**
 * The browsers an account remembers (#990, #1031). A device cookie (`device-cookie.ts`) names an account by a keyed hash of its address
 * and its **device generation**, a number on the account that a password reset and "Sign out all other devices" raise. A copy of the cookie
 * that was taken before then names an older generation, so it stops counting as that browser; the browser that did the reset or the
 * sign-out is given a cookie with the new one at once.
 */
export interface Devices {
  /** The cookie's name and options (`Secure` over HTTPS), for whoever sets it. */
  cookie: { name: string; options: { maxAge: number; httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/' } };
  /** The device a cookie value names when it is signed by this server and lists this account at its current generation; else null. */
  known(value: string | null | undefined, email: string): Promise<Device | null>;
  /** The cookie value that remembers this account (at its current generation, its older keys taken out) for the browser that sent `value`, if any. */
  remember(value: string | null | undefined, email: string): Promise<string>;
  /** Every cookie given out so far stops counting as a browser of this account. Remember the browser in hand afterwards. */
  endAll(userId: string): Promise<void>;
}

/** How many older generations of an account's key `remember` takes out of a cookie; a key older than that stays until newer accounts push it out. */
const OLDER_GENERATIONS = 16;

export function createDevices(db: Database, secret: string, secure: boolean): Devices {
  const address = (email: string) => email.trim().toLowerCase();
  // An address nobody holds has generation 0: a cookie can only name an account it signed in to.
  const generationOf = async (email: string) => {
    const [row] = await db.select({ generation: schema.authUsers.deviceGeneration }).from(schema.authUsers).where(sql`lower(${schema.authUsers.email}) = ${address(email)}`);
    return row?.generation ?? 0;
  };
  const keyAt = (email: string, generation: number) => createHmac('sha256', secret)
    .update('flux-device-account\0').update(address(email)).update('\0').update(String(generation)).digest('hex').slice(0, 16);
  // The key of this account now, and of its last few older generations, which a cookie may still list and `remember` takes out of it.
  const keysOf = async (email: string) => {
    const generation = await generationOf(email);
    return { current: keyAt(email, generation), older: Array.from({ length: Math.min(generation, OLDER_GENERATIONS) }, (_, back) => keyAt(email, generation - 1 - back)) };
  };
  return {
    cookie: { name: deviceCookieName(secure), options: { maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS, httpOnly: true, sameSite: 'lax', secure, path: '/' } },
    async known(value, email) {
      const device = readDevice(secret, value);
      return device && knows(device, (await keysOf(email)).current) ? device : null;
    },
    async remember(value, email) {
      const { current, older } = await keysOf(email);
      return writeDevice(secret, withAccount(readDevice(secret, value), current, older));
    },
    async endAll(userId) {
      await db.update(schema.authUsers).set({ deviceGeneration: sql`${schema.authUsers.deviceGeneration} + 1` }).where(eq(schema.authUsers.id, userId));
    },
  };
}
