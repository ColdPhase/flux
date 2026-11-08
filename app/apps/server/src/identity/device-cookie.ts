import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The device cookie of the account back-off (#990; OWASP "Slow Down Online Guessing Attacks with Device Cookies"). A browser that has
 * signed in to an account, or finished that account's password reset, keeps a signed cookie naming the account. Its wrong guesses count in
 * a wait of their own (this account on this browser), and a stranger's guesses at the same address, which count in the account's wait,
 * never lock it out. A cookie lists the accounts of the browser by keyed hash, so a cookie won by signing in to one's own account
 * says nothing about anyone else's, and nothing in it can be forged without the server's secret.
 */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 86_400;
const MAX_ACCOUNTS = 8;
const KEY_LENGTH = 16;

export interface Device { id: string; accounts: string[] }

export const deviceCookieName = (secure: boolean) => `${secure ? '__Secure-' : ''}flux.device`;

const sign = (secret: string, id: string, accounts: string) =>
  createHmac('sha256', secret).update('flux-device-cookie\0').update(id).update('\0').update(accounts).digest('base64url');

/** The device a cookie value names, or null when it is absent, malformed or not signed by this server. */
export function readDevice(secret: string, value: string | null | undefined): Device | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [id, accounts, signature] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[0-9a-f]*$/.test(accounts) || accounts.length % KEY_LENGTH !== 0 || accounts.length > MAX_ACCOUNTS * KEY_LENGTH) return null;
  const expected = Buffer.from(sign(secret, id, accounts));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id, accounts: accounts.match(new RegExp(`.{${KEY_LENGTH}}`, 'g')) ?? [] };
}

/** The cookie value of a device. */
export function writeDevice(secret: string, device: Device): string {
  const accounts = device.accounts.join('');
  return `${device.id}.${accounts}.${sign(secret, device.id, accounts)}`;
}

/**
 * The device with this account added (a new device when it had none); the newest accounts stay when there are many. `replaces` are keys the
 * account had before (older device generations, `devices.ts`): they leave the list, so they do not take the slots of other accounts.
 */
export function withAccount(device: Device | null, accountKey: string, replaces: readonly string[] = []): Device {
  const key = accountKey.slice(0, KEY_LENGTH);
  const gone = new Set([key, ...replaces.map((old) => old.slice(0, KEY_LENGTH))]);
  return { id: device?.id ?? randomBytes(16).toString('base64url'), accounts: [key, ...(device?.accounts ?? []).filter((item) => !gone.has(item))].slice(0, MAX_ACCOUNTS) };
}

export const knows = (device: Device | null, accountKey: string): device is Device => !!device && device.accounts.includes(accountKey.slice(0, KEY_LENGTH));
