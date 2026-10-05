import { randomBytes, randomUUID, createECDH } from 'node:crypto';
import { readFile, writeFile, rename, stat, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const NODE_IMAGE = 'node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1';
export function boundedInteger(value, min, max, label) {
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${label}`);
  return Number(value);
}
export function publicOrigin(value, local = false) {
  const u = new URL(value);
  if (u.origin !== value || u.username || u.password) throw new Error('Expected an exact origin without a path');
  if (local ? (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') :
    (u.protocol !== 'https:' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(u.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname))) throw new Error('Expected a device-reachable trusted HTTPS origin');
  return u.origin;
}
// Typed on phones: 20 characters from 32 unambiguous ones (no 0, i, l or o), 100 random bits.
const READABLE = 'abcdefghjkmnpqrstuvwxyz123456789';
export function readablePassword() {
  const letters = [...randomBytes(20)].map(byte => READABLE[byte & 31]).join('');
  return letters.match(/.{5}/g).join('-');
}
export async function privateDirectory(directory) {
  const path = resolve(directory);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('Fixture state must be an owned private directory (0700)');
  return path;
}
export async function readJson(directory, name) {
  const file = join(directory, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 1_048_576) throw new Error(`Unsafe state file: ${name}`);
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function writePrivate(directory, name, contents) {
  const temporary = join(directory, `.${name}.${randomUUID()}`);
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, name));
}
export const writeJson = (directory, name, data) => writePrivate(directory, name, `${JSON.stringify(data, null, 2)}\n`);
export async function readState(directory) {
  const state = await readJson(directory, 'state.json');
  if (state.schema !== 1 || !/^[a-f0-9]{40}$/.test(state.candidate) || !/^flux-mobile-[a-f0-9]{12}$/.test(state.project)) throw new Error('Invalid fixture state');
  if (!Number.isSafeInteger(state.createdAt) || !Number.isSafeInteger(state.expiresAt) || state.expiresAt > state.createdAt + 4 * 3600_000 || Date.now() >= state.expiresAt) throw new Error('Fixture lease expired or invalid; clean up and initialize another fixture');
  return state;
}
export async function writeEnv(directory, state) {
  const secret = await readJson(directory, 'secrets.json');
  const values = {
    MOBILE_PROJECT: state.project, MOBILE_STATE: process.env.MOBILE_HOST_STATE ?? directory, MOBILE_PORT: state.port,
    MOBILE_UID: process.getuid(), MOBILE_GID: process.getgid(),
    MOBILE_IMAGE: state.image ?? 'flux-mobile-unbuilt', MOBILE_ORIGIN: state.origin,
    MOBILE_DB_PASSWORD: secret.databasePassword, MOBILE_AUTH_SECRET: secret.authSecret,
    MOBILE_VAPID_PUBLIC: secret.vapid.publicKey, MOBILE_VAPID_PRIVATE: secret.vapid.privateKey,
    // Apple's push service refused the unreachable `mailto:…@example.test` contact with 403 BadJwtToken
    // on a real iPhone (#20, 2026-10-05). Once public, the session signs with its own https origin.
    MOBILE_VAPID_SUBJECT: state.origin.startsWith('https://') ? state.origin : 'mailto:mobile-fixture@example.test',
    MOBILE_BROWSER_IMAGE: state.browserImage ?? 'selenium-unconfigured',
  };
  // Restricted state paths and generated values never need dotenv interpolation or quoting.
  if (Object.values(values).some(v => !/^[a-zA-Z0-9_./:@-]+$/.test(String(v)))) throw new Error('Unsafe fixture configuration');
  await writePrivate(directory, 'fixture.env', Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
export async function initialize(directory, candidate, port = '8232') {
  await privateDirectory(directory);
  try { await stat(join(directory, 'state.json')); throw new Error('Fixture already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error('Expected a full candidate commit SHA');
  const number = boundedInteger(port, 1024, 65535, 'loopback port');
  const suffix = randomBytes(6).toString('hex');
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const credentials = alias => ({ email: `${alias}-${suffix.slice(0, 4)}@example.test`, password: readablePassword(), name: `Mobile fixture ${alias}` });
  const secret = { databasePassword: randomBytes(32).toString('hex'), authSecret: randomBytes(32).toString('hex'),
    vapid: { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') },
    recipient: credentials('recipient'), producer: credentials('producer') };
  const state = { schema: 1, candidate, project: `flux-mobile-${suffix}`, port: number,
    origin: `http://127.0.0.1:${number}`, createdAt: Date.now(), expiresAt: Date.now() + 4 * 3600_000,
    seeded: false, replies: [], devices: [], observations: [] };
  await writeJson(directory, 'secrets.json', secret); await writeJson(directory, 'state.json', state);
  await writeJson(directory, 'boundary.json', { enabled: false, expiresAt: state.expiresAt });
  await writeEnv(directory, state);
  return { candidate, project: state.project, expiresAt: new Date(state.expiresAt).toISOString() };
}
