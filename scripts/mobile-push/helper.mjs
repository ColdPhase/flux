import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { initialize, privateDirectory, publicOrigin, readJson, readState, writeJson, writePrivate, writeEnv } from './state.mjs';

export class Client {
  cookies = new Map();
  constructor(base, origin) { this.base = base; this.origin = origin; }
  async request(method, path, body, expected = 200, origin = this.origin) {
    const response = await fetch(new URL(path, this.base), { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { origin, ...(this.cookies.size ? { cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';'); const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim(); const value = pair.slice(index + 1).trim();
      if (!value || attributes.some(a => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    // Never interpolate response bodies, cookies, endpoint URLs or credentials into an error.
    if (response.status !== expected) { await response.body?.cancel(); throw new Error(`${method} API request returned ${response.status}; expected ${expected}`); }
    return expected === 204 ? null : response.json();
  }
}
const alias = id => createHash('sha256').update(id).digest('hex').slice(0, 12);
export async function signedIn(directory, state, person) {
  const secret = await readJson(directory, 'secrets.json');
  const client = new Client(process.env.MOBILE_API ?? 'http://api:8080', state.origin);
  await client.request('POST', '/api/auth/sign-in/email', { email: secret[person].email, password: secret[person].password });
  const me = await client.request('GET', '/api/v1/me');
  if (state[person]?.id && me.user.id !== state[person].id) throw new Error('Fixture identity mismatch');
  return { client, me };
}
async function withPerson(directory, state, person, operation) {
  const { client, me } = await signedIn(directory, state, person);
  try { return await operation(client, me); } finally { await client.request('POST', '/api/auth/sign-out', {}); }
}
async function database(operation) {
  const require = createRequire('/app/packages/db/package.json');
  const { Client: PgClient } = require('pg');
  const db = new PgClient({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  await db.connect();
  try { await db.query('SET default_transaction_read_only = on'); return await operation(db); } finally { await db.end(); }
}
async function seed(directory, state) {
  if (state.seeded || state.seedStarted) throw new Error('Fixture already seeded or partially seeded; initialize a fresh fixture after a failure');
  state.seedStarted = true; await writeJson(directory, 'state.json', state);
  const secret = await readJson(directory, 'secrets.json'); const clients = {};
  try {
    for (const person of ['producer', 'recipient']) {
      const client = new Client(process.env.MOBILE_API ?? 'http://api:8080', state.origin); clients[person] = client;
      await client.request('POST', '/api/auth/sign-up/email', secret[person]);
      state[person] = { id: (await client.request('GET', '/api/v1/me')).user.id };
    }
    const owner = clients.producer; const recipient = clients.recipient;
    const workspace = await owner.request('POST', '/api/v1/workspaces', { name: 'Disposable mobile push verification' }, 201);
    await owner.request('POST', `/api/v1/workspaces/${workspace.id}/members`, { email: secret.recipient.email, role: 'member' }, 201);
    const project = await owner.request('POST', `/api/v1/workspaces/${workspace.id}/projects`, { name: 'Phone push fixture', visibility: 'workspace' }, 201);
    const conversation = await recipient.request('POST', `/api/v1/projects/${project.id}/conversations`, {
      body: 'Synthetic phone verification conversation. Reply here to exercise the normal notification pipeline.', clientMessageId: randomUUID() }, 201);
    state.workspaceId = workspace.id; state.projectId = project.id; state.conversationId = conversation.id; state.seeded = true;
    await writeJson(directory, 'state.json', state);
    await writePrivate(directory, 'operator.md', `Private synthetic fixture. Never attach this file to a PR.\n\nCandidate: ${state.candidate}\nOrigin: ${state.origin}\nRecipient email: ${secret.recipient.email}\nRecipient password: ${secret.recipient.password}\n\nOpen /projects/${project.id}/conversations/${conversation.id}\nUse the normal sign-in and notification settings UI. On iPhone/iPad first add to Home Screen and launch there.\n`);
    return { seeded: true, candidate: state.candidate, operatorFile: '/state/operator.md', conversation: alias(conversation.id) };
  } finally {
    for (const client of Object.values(clients)) if (client.cookies.size) await client.request('POST', '/api/auth/sign-out', {});
  }
}
async function inspect(directory, state) {
  if (!state.seeded) throw new Error('Seed the fixture first');
  const subscriptions = await withPerson(directory, state, 'recipient', c => c.request('GET', '/api/v1/push/subscriptions'));
  const details = await database(async db => {
    const devices = await db.query('SELECT id, session_id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at, id LIMIT 16', [state.recipient.id]);
    const events = await db.query("SELECT id, data->>'messageId' AS message FROM events WHERE object_id = $1 AND data->>'messageId' = ANY($2::text[]) ORDER BY seq LIMIT 100", [state.projectId, state.replies.map(r => r.messageId)]);
    const rows = await db.query('SELECT id, event_id, reason, url, created_at FROM notifications WHERE user_id = $1 AND source_id = $2 ORDER BY created_at DESC LIMIT 100', [state.recipient.id, state.projectId]);
    const jobs = await db.query("SELECT id, state, retry_count, started_on, completed_on, data->>'notificationId' AS notification, data->>'subscriptionId' AS subscription FROM pgboss.job WHERE name = 'push.send' AND data->>'userId' = $1 ORDER BY created_on DESC LIMIT 100", [state.recipient.id]);
    return { devices: devices.rows, events: events.rows, notifications: rows.rows, jobs: jobs.rows };
  });
  for (const device of details.devices) if (!state.devices.some(d => d.id === device.id)) state.devices.push({ id: device.id, sessionId: device.session_id, alias: `device-${state.devices.length + 1}` });
  const output = { candidate: state.candidate, image: state.image, origin: state.origin, at: new Date().toISOString(),
    subscriptions: subscriptions.map(s => ({ alias: state.devices.find(d => d.id === s.id)?.alias, providerOrigin: s.endpointOrigin,
      lastSuccessAt: s.lastSuccessAt, lastFailureAt: s.lastFailureAt, lastFailureStatus: s.lastFailureStatus })),
    replies: state.replies.map(r => ({ marker: r.marker, message: alias(r.messageId), expectedTarget: r.target })),
    events: details.events.map(e => ({ alias: alias(e.id), message: alias(e.message) })),
    notifications: details.notifications.map(n => ({ alias: alias(n.id), event: n.event_id ? alias(n.event_id) : null, reason: n.reason, target: n.url, createdAt: n.created_at })),
    jobs: details.jobs.map(j => ({ alias: alias(j.id), state: j.state, attempts: j.started_on ? j.retry_count + 1 : 0, completedAt: j.completed_on, notification: alias(j.notification),
      device: state.devices.find(d => d.id === j.subscription)?.alias ?? 'removed-device' })),
    queryLimits: { subscriptions: 16, events: 100, notifications: 100, jobs: 100 },
    limitation: 'Provider acceptance and local API records do not establish OS display, physical installation or tap behavior.' };
  await writeJson(directory, 'state.json', state); await writeJson(directory, 'inspection.json', output);
  return output;
}
async function boundary(directory, state, mode, origin, reviewedCandidate) {
  if (mode === 'close') { await writeJson(directory, 'boundary.json', { enabled: false, expiresAt: state.expiresAt }); return { closed: true }; }
  if (!state.seeded || !state.image?.startsWith('sha256:')) throw new Error('Build and seed the pinned fixture before opening');
  if (mode === 'https' && reviewedCandidate !== state.candidate) throw new Error('The independent boundary review must name this candidate SHA');
  const nextOrigin = publicOrigin(origin, mode === 'local');
  if (mode === 'local' && nextOrigin !== `http://127.0.0.1:${state.port}`) throw new Error('Local origin must match the reserved loopback port');
  if (state.devices.length && nextOrigin !== state.origin) throw new Error('Origin cannot change after device subscriptions; close and initialize another fixture');
  // Keep closed while the caller recreates API/worker at the new public origin.
  await writeJson(directory, 'boundary.json', { enabled: false, origin: nextOrigin, expiresAt: state.expiresAt });
  state.origin = nextOrigin; state.boundaryReview = mode === 'https' ? reviewedCandidate : null;
  await writeJson(directory, 'state.json', state); await writeEnv(directory, state);
  const operator = await readJson(directory, 'secrets.json');
  await writePrivate(directory, 'operator.md', `Private synthetic fixture. Never attach to a PR.\nCandidate: ${state.candidate}\nOrigin: ${state.origin}\nRecipient email: ${operator.recipient.email}\nRecipient password: ${operator.recipient.password}\nConversation: ${state.origin}/projects/${state.projectId}/conversations/${state.conversationId}\n`);
  return { prepared: true, origin: state.origin, review: state.boundaryReview };
}
export async function main(args, directory = process.env.MOBILE_STATE ?? '/state') {
  await privateDirectory(directory);
  const [command, ...rest] = args;
  if (command === 'init') return initialize(directory, rest[0], rest[1]);
  if (command === 'close') { await writeJson(directory, 'boundary.json', { enabled: false }); return { closed: true }; }
  const state = await readState(directory);
  if (command === 'image') {
    if (!/^sha256:[a-f0-9]{64}$/.test(rest[0])) throw new Error('Expected an exact local image content ID');
    state.image = rest[0]; await writeJson(directory, 'state.json', state); await writeEnv(directory, state); return { candidate: state.candidate, image: state.image };
  }
  if (command === 'browser-image') {
    if (!/^selenium\/standalone-chrome@sha256:[a-f0-9]{64}$/.test(rest[0])) throw new Error('Expected an official Selenium Chrome image pinned by digest');
    state.browserImage = rest[0]; await writeJson(directory, 'state.json', state); await writeEnv(directory, state); return { browserImage: state.browserImage };
  }
  if (command === 'boundary') return boundary(directory, state, ...rest);
  if (command === 'enable') {
    if (rest[0] !== state.origin) throw new Error('Origin changed during boundary preparation');
    await writeJson(directory, 'boundary.json', { enabled: true, origin: state.origin, expiresAt: Math.min(state.expiresAt, Date.now() + 2 * 3600_000) });
    return { enabled: true, origin: state.origin, lease: 'At most two hours; initial fixture maximum four hours' };
  }
  if (command === 'seed') return seed(directory, state);
  if (command === 'inspect') return inspect(directory, state);
  if (!state.seeded) throw new Error('Seed the fixture first');
  if (command === 'reply') {
    if (state.replies.length >= 40) throw new Error('Fixture reply cap reached');
    const label = rest[0] ?? 'delivery'; if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('Use a short non-secret case label');
    const marker = `mobile-${label}-${randomUUID()}`;
    const message = await withPerson(directory, state, 'producer', c => c.request('POST', `/api/v1/conversations/${state.conversationId}/messages`, { body: `Synthetic verification ${marker}`, clientMessageId: randomUUID() }, 201));
    const target = `/projects/${state.projectId}/conversations/${state.conversationId}#message-${message.id}`;
    state.replies.push({ marker, messageId: message.id, target }); await writeJson(directory, 'state.json', state);
    return { marker, expectedTarget: target, next: 'Inspect after the worker runs; record physical display and tap separately' };
  }
  if (command === 'mute' || command === 'unmute') return withPerson(directory, state, 'recipient', async c => {
    await c.request('PUT', '/api/v1/notification-preferences/mutes', { type: 'project', id: state.projectId, muted: command === 'mute' }); return { muted: command === 'mute' }; });
  if (command === 'deny' || command === 'restore') return withPerson(directory, state, 'producer', async c => {
    await c.request('POST', `/api/v1/projects/${state.projectId}/grants`, { principal: { kind: 'human', id: state.recipient.id }, role: command === 'deny' ? 'denied' : 'contributor' }, 201); return { recipientAccess: command }; });
  if (command === 'unsubscribe' || command === 'revoke') {
    const device = state.devices.find(d => d.alias === rest[0]); if (!device) throw new Error('Inspect and select an exact fixture device alias first');
    return withPerson(directory, state, 'recipient', async c => {
      await c.request('DELETE', command === 'unsubscribe' ? `/api/v1/push/subscriptions/${device.id}` : `/api/v1/sessions/${device.sessionId}`, undefined, 204);
      return { action: command, device: device.alias, next: 'Generate another reply; observe no physical delivery. Recovery uses the normal device login/consent UI.' }; });
  }
  if (command === 'probe') return withPerson(directory, state, 'recipient', async c => {
    const secret = await readJson(directory, 'secrets.json');
    await c.request('POST', '/api/v1/push/subscriptions', { endpoint: 'https://127.0.0.1/forbidden', keys: { p256dh: secret.vapid.publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }, 400);
    await c.request('PUT', '/api/v1/notification-preferences/mutes', { type: 'project', id: state.projectId, muted: false }, 403, 'https://foreign.invalid');
    await c.request('POST', '/api/v1/integration/sample', { title: 'must be unauthorized' }, 401);
    const key = await c.request('GET', '/api/v1/push/public-key'); if (key.status !== 'available') throw new Error('VAPID public key unavailable');
    return { privateEndpointRejected: true, foreignOriginRejected: true, fixtureCommandDisabled: true, pushConfigured: true }; });
  if (command === 'verify-origin') {
    publicOrigin(state.origin);
    const base = state.origin;
    for (const [path, expected] of [['/api/v1/health', 200], ['/manifest.webmanifest', 200], ['/sw.js', 200], ['/api/v1/me', 401]]) {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      if (response.status !== expected) { await response.body?.cancel(); throw new Error(`HTTPS origin probe ${path} returned ${response.status}`); }
      if (path === '/manifest.webmanifest') {
        const manifest = await response.json();
        if (!manifest.start_url || new URL(manifest.start_url, base).origin !== base || !manifest.id || new URL(manifest.id, base).origin !== base) throw new Error('Manifest identity/start URL is inconsistent with origin');
      } else await response.body?.cancel();
    }
    const evidence = { at: new Date().toISOString(), candidate: state.candidate, image: state.image, origin: base,
      trustedTls: true, redirects: false, health: true, manifestIdentity: true, serviceWorker: true, anonymousIdentityRejected: true,
      limitation: 'This is server-side HTTPS evidence; device installation and notification display remain unverified.' };
    await writeJson(directory, 'https-verification.json', evidence); return evidence;
  }
  if (command === 'record') {
    const [platform, scenario, verdict, evidence, versions] = rest;
    const platforms = ['android', 'iphone', 'ipad', 'desktop-provider'];
    const scenarios = ['installation', 'cold-launch', 'background-display', 'locked-display', 'tap-target', 'mute', 'unsubscribe', 'revoke', 'recovery', 'permission-denied', 'offline', 'touch', 'accessibility'];
    if (!platforms.includes(platform) || !scenarios.includes(scenario) || !['pass', 'fail', 'unverified'].includes(verdict) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(evidence ?? '') || !versions || versions.length > 250 || versions.includes('://') || versions.includes('@')) throw new Error('Record exact platform/case/verdict, a private evidence filename and OS/browser/device versions');
    if (['secrets.json', 'fixture.env', 'operator.md', 'state.json', '.lock'].includes(evidence) || evidence.endsWith('.log')) throw new Error('Private fixture credentials/raw logs are not review evidence');
    if (state.observations.length >= 200) throw new Error('Evidence observation cap reached');
    const info = await lstat(join(directory, evidence));
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 64 * 1024 * 1024) throw new Error('Evidence must be an existing private nonsymlinked file of at most 64 MiB');
    const digest = createHash('sha256').update(await readFile(join(directory, evidence))).digest('hex');
    state.observations.push({ platform, scenario, verdict, evidence, digest, versions, candidate: state.candidate, at: new Date().toISOString() });
    await writeJson(directory, 'state.json', state); return { recorded: true, platform, scenario, verdict };
  }
  if (command === 'matrix') {
    const scenarios = ['installation', 'cold-launch', 'background-display', 'locked-display', 'tap-target', 'mute', 'unsubscribe', 'revoke', 'recovery', 'permission-denied', 'offline', 'touch', 'accessibility'];
    const rows = ['android', 'iphone', 'ipad', 'desktop-provider'].flatMap(platform => scenarios.map(scenario => {
      const observation = state.observations.findLast(o => o.platform === platform && o.scenario === scenario);
      return observation ?? { platform, scenario, verdict: 'unverified', candidate: state.candidate, next: platform === 'desktop-provider' ? 'Use an actual browser subscription/provider; keep this separate from physical evidence' : 'Connect the named physical platform and record versions, observation and private evidence' };
    }));
    await writeJson(directory, 'evidence-matrix.json', rows); return rows;
  }
  throw new Error('Unknown fixture command');
}
if (process.argv[1]?.endsWith('/helper.mjs')) {
  let code = 0;
  let output;
  let stream = process.stdout;
  try { output = JSON.stringify(await main(process.argv.slice(2)), null, 2); }
  catch (error) { output = `Fixture operation failed: ${error.message}`; code = 1; stream = process.stderr; }
  // A finite helper has finished every awaited API/state/DB operation at this point.
  // Flush its result before explicitly completing this finite tools job.
  await new Promise((resolve) => stream.write(`${output}\n`, resolve));
  process.exit(code);
}
