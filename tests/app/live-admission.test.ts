import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase } from '@flux/db';
import { grantProject } from '@flux/core';
import type { Conversation, LiveJoinGrant } from '@flux/contracts';
import { loadIdentityConfig, registerIdentity } from '../../apps/server/src/identity/index.js';
import { liveAccess } from '../../apps/server/src/live/access.js';
import { liveRoutes } from '../../apps/server/src/live/routes.js';
import { liveSessionStore } from '../../apps/server/src/live/store.js';
import { createLiveMedia, liveMediaConfig, participantIdentity, type LiveMediaAdapter, type ParticipantAdmission } from '../../apps/server/src/live/media.js';
import { registerLiveSignaling } from '../../apps/server/src/live/signaling.js';
import { admissionRevocation } from '../../apps/server/src/live/admission-revocation.js';
import { liveAdmissionStore } from '../../apps/server/src/live/admissions.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, password, person, project, workspace, type Person } from './support/people.js';

// Media admission bound to the auth session, the signaling gate and revocation on session end
// (#128). The Flux side is real: Better Auth sessions and sign-out in process, PostgreSQL with
// the 0022 trigger and LISTEN, the live use cases and the gate. The SFU is a local WebSocket
// server that records every signaling connection, plus an in-memory room service.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(connectionString);
const publicOrigin = 'http://127.0.0.1:18128';
// Shared with the API container, which created the Better Auth JWKS the in-process instance reads.
const authSecret = process.env.FLUX_AUTH_SECRET;
if (!authSecret) throw new Error('FLUX_AUTH_SECRET is required');
const apiKey = 'fluxgatetestkey';
const apiSecret = 'fluxgatetestsecretwithatleast32characters';

interface Sfu {
  server: Server;
  port: number;
  signals: { path: string; query: URLSearchParams; headers: IncomingHttpHeaders; socket: WebSocket }[];
  validations: string[];
  sockets: Set<WebSocket>;
  rooms: Map<string, ParticipantAdmission[]>;
  calls: string[];
  /** What the fake LiveKit room service (Twirp) holds, for the real media adapter. */
  service: Map<string, { identity: string; metadata: string; state: number; joinedAt: number }[]>;
  serviceCalls: string[];
}

let sfu: Sfu;
let app: FastifyInstance;
let gateUrl: string;
/** The production LiveKit adapter, pointed at the fake room service. */
let realMedia: LiveMediaAdapter;
const resetMails: { to: string; text: string }[] = [];

async function startSfu(): Promise<Sfu> {
  const state: Omit<Sfu, 'server' | 'port'> = { signals: [], validations: [], sockets: new Set(), rooms: new Map(), calls: [],
    service: new Map(), serviceCalls: [] };
  const server = createServer((request, response) => {
    const method = /^\/twirp\/livekit\.RoomService\/(\w+)$/.exec(request.url ?? '')?.[1];
    if (!method) {
      state.validations.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'text/plain' }).end('success');
      return;
    }
    let raw = '';
    request.on('data', (chunk) => { raw += String(chunk); });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as { room?: string; names?: string[]; identity?: string };
      const held = state.service.get(body.room ?? '') ?? [];
      const reply = (value: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (method === 'ListParticipants') return reply({ participants: held.map((participant) => ({ ...participant,
        state: participant.state === 2 ? 'ACTIVE' : 'JOINED', joinedAt: String(participant.joinedAt) })) });
      if (method === 'ListRooms') return reply({ rooms: (body.names ?? []).filter((name) => state.service.has(name)).map((name) => ({ name })) });
      state.serviceCalls.push(`${method}:${body.identity}`);
      if (!held.some((participant) => participant.identity === body.identity)) {
        return response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'not_found', msg: 'participant not found' }));
      }
      if (method === 'RemoveParticipant') state.service.set(body.room!, held.filter((participant) => participant.identity !== body.identity));
      return reply(method === 'UpdateParticipant' ? { identity: body.identity } : {});
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://sfu.invalid');
    state.signals.push({ path: url.pathname, query: url.searchParams, headers: request.headers, socket });
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    // Stands in for LiveKit's JoinResponse: the participant list and metadata a denied client must not see.
    socket.send(Buffer.from('join-response:participants'));
    socket.on('message', (data, binary) => socket.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]), { binary }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ...state, server, port: (server.address() as AddressInfo).port };
}

function roomMedia(state: Sfu, real: LiveMediaAdapter): LiveMediaAdapter {
  return {
    async ensureRoom(roomId) { if (!state.rooms.has(roomId)) state.rooms.set(roomId, []); },
    async requireRoom() {},
    grant: real.grant,
    async participants() { return []; },
    async participantAdmissions(roomId) { return [...(state.rooms.get(roomId) ?? [])]; },
    async revokeParticipant(roomId, identity) {
      state.calls.push(`drop:${roomId}:${identity}`, `remove:${roomId}:${identity}`);
      state.rooms.set(roomId, (state.rooms.get(roomId) ?? []).filter((participant) => participant.identity !== identity));
    },
    async occupancy(roomId) { return state.rooms.get(roomId)?.length ?? 0; },
    async removeParticipant() {},
    async deleteRoom(roomId) { state.rooms.delete(roomId); },
  };
}

before(async () => {
  sfu = await startSfu();
  const config = liveMediaConfig({ FLUX_LIVEKIT_API_URL: `http://127.0.0.1:${sfu.port}`, FLUX_LIVEKIT_API_KEY: apiKey,
    FLUX_LIVEKIT_API_SECRET: apiSecret, FLUX_LIVEKIT_ALLOW_INSECURE_LOCAL: 'true' }, publicOrigin);
  realMedia = createLiveMedia(config);
  const media = roomMedia(sfu, realMedia);
  app = Fastify();
  const identity = registerIdentity(app, {
    db, config: loadIdentityConfig({ FLUX_PUBLIC_ORIGIN: publicOrigin, FLUX_AUTH_SECRET: authSecret, FLUX_AUTH_RATE_LIMIT: 'false' }),
    mailer: { async send(message) { resetMails.push(message); }, close() {} },
  });
  const ports = { access: liveAccess(db), sessions: liveSessionStore(db), media, mediaUrl: config.mediaUrl };
  await app.register(liveRoutes, { sessions: identity, ports });
  const signaling = registerLiveSignaling(app, { db, connectionString, publicOrigin, sessions: identity, ports, media, config });
  app.server.on('upgrade', (request, socket, head) => {
    if (!signaling.gate.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  gateUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  await app?.close();
  for (const socket of sfu?.sockets ?? []) socket.terminate();
  await new Promise((resolve) => sfu?.server.close(resolve));
  await pool.end();
});

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A browser session of `someone` against the in-process Flux API (its own Better Auth). */
async function signedIn(someone: Person): Promise<{ browser: Browser; sessionId: string }> {
  const browser = new Browser(gateUrl, publicOrigin);
  expectStatus(await browser.request('POST', '/api/auth/sign-in/email', { body: { email: someone.email, password } }), 200);
  const me = expectStatus(await browser.request('GET', '/api/v1/me'), 200) as { session: { id: string } };
  return { browser, sessionId: me.session.id };
}

/** Keeps the cookies as they are now, e.g. a copy an attacker took before sign-out. */
function copyOf(browser: Browser): Browser {
  const copy = new Browser(browser.base, browser.defaultOrigin);
  for (const [name, value] of browser.cookies) copy.cookies.set(name, value);
  return copy;
}

function claims(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    sub: string; metadata?: string; exp: number; video: { room: string; canUpdateOwnMetadata?: boolean };
  };
}

/** Signs claims like the SFU does on refresh: same key, same identity and metadata, new expiry. */
function signed(payload: Record<string, unknown>, secret = apiSecret) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: apiKey, nbf: Math.floor(Date.now() / 1000) - 5, ...payload })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

type Outcome = { opened: true; socket: WebSocket; first: Promise<string> } | { opened: false; status: number };

/** Opens `/media/rtc/v1` the way livekit-client 2.17.2 does; resolves on upgrade or refusal. */
function signal(token: string, browser: Browser | null, options: { origin?: string; path?: string } = {}): Promise<Outcome> {
  const url = `${gateUrl.replace(/^http/, 'ws')}/media${options.path ?? '/rtc/v1'}?access_token=${encodeURIComponent(token)}&join_request=${encodeURIComponent('AAEC')}`;
  const headers: Record<string, string> = { origin: options.origin ?? publicOrigin };
  if (browser?.cookies.size) headers.cookie = browser.cookieHeader();
  const socket = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    const first = new Promise<string>((resolveFirst) => socket.once('message', (data) => resolveFirst(String(data))));
    socket.once('open', () => resolve({ opened: true, socket, first }));
    socket.once('unexpected-response', (_request, response) => { resolve({ opened: false, status: response.statusCode ?? 0 }); response.resume(); socket.terminate(); });
    socket.once('error', (error) => reject(error));
  });
}

async function refused(outcome: Promise<Outcome>, status = 401) {
  const result = await outcome;
  assert.equal(result.opened, false, 'the gate must not upgrade');
  if (!result.opened) assert.equal(result.status, status);
}

async function opened(outcome: Promise<Outcome>) {
  const result = await outcome;
  assert.ok(result.opened, 'the gate upgrades an admitted request');
  assert.equal(await result.first, 'join-response:participants');
  return result.socket;
}

async function scene(label: string) {
  const owner = await person(`${label}-owner`);
  const member = await person(`${label}-member`);
  const ws = await workspace(owner, label);
  await addMember(owner, ws.id, member, 'member');
  const place = await project(owner, ws.id, `${label} project`, 'restricted');
  await grant(owner, place.id, member, 'viewer');
  const thread = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
    body: { body: `${label} anchor`, clientMessageId: randomUUID() } }), 201) as Conversation;
  const session = await liveSessionStore(db).createOrGet({ kind: 'human', id: owner.id }, place.id,
    { type: 'conversation', id: thread.id }, randomUUID(), async (roomId) => { sfu.rooms.set(roomId, []); });
  const join = async (browser: Browser) =>
    expectStatus(await browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
  /** Records the participant the SFU would hold after this grant connects: one per admission. */
  const connect = (userId: string, grantToken: string) => {
    const { sub, metadata } = claims(grantToken);
    const others = (sfu.rooms.get(session.roomId) ?? []).filter((participant) => participant.identity !== sub);
    sfu.rooms.set(session.roomId, [...others, { userId, identity: sub, admissionId: metadata ?? null }]);
  };
  return { owner, member, place, session, join, connect };
}

async function admissionRow(id: string) {
  const result = await pool.query<{ auth_session_id: string; user_id: string; revoked_at: Date | null }>(
    'SELECT auth_session_id, user_id, revoked_at FROM live_admissions WHERE id = $1', [id]);
  return result.rows[0];
}

describe('live media admission (#128)', () => {
  test('media configuration keeps the SFU private and points browsers at the gate', () => {
    const env = { FLUX_LIVEKIT_API_KEY: apiKey, FLUX_LIVEKIT_API_SECRET: apiSecret };
    const config = liveMediaConfig({ ...env, FLUX_LIVEKIT_API_URL: 'http://livekit:7880', NODE_ENV: 'production' }, 'https://flux.example.org');
    assert.equal(config.mediaUrl, 'wss://flux.example.org/media');
    assert.equal(config.signalUrl, 'ws://livekit:7880');
    assert.equal(liveMediaConfig({ ...env, FLUX_LIVEKIT_API_URL: 'https://sfu.internal.example' }, publicOrigin).mediaUrl, 'ws://127.0.0.1:18128/media');
    assert.throws(() => liveMediaConfig({ ...env, FLUX_LIVEKIT_API_URL: 'http://livekit:7880', FLUX_LIVEKIT_WS_URL: 'wss://sfu.example.org' }, publicOrigin),
      /FLUX_LIVEKIT_WS_URL is no longer used/);
    assert.throws(() => liveMediaConfig({ ...env, FLUX_LIVEKIT_API_URL: 'http://sfu.example.org' }, publicOrigin), /HTTPS/);
    assert.throws(() => liveMediaConfig({ ...env, FLUX_LIVEKIT_API_URL: 'http://127.0.0.1:7880', NODE_ENV: 'production',
      FLUX_LIVEKIT_ALLOW_INSECURE_LOCAL: 'true' }, publicOrigin), /HTTPS/);
  });

  test('a grant carries only an opaque admission bound to the requesting auth session', async () => {
    const s = await scene('admission-binding');
    const laptop = await signedIn(s.member);
    const issued = await s.join(laptop.browser);
    assert.equal(issued.mediaUrl, `${publicOrigin.replace(/^http/, 'ws')}/media`);
    const payload = claims(issued.token);
    assert.match(payload.metadata ?? '', /^[A-Za-z0-9_-]{22}$/, '128 random bits, base64url');
    assert.equal(payload.video.room, s.session.roomId);
    assert.equal(payload.video.canUpdateOwnMetadata, false);
    assert.equal(JSON.stringify(payload).includes(laptop.sessionId), false, 'the auth session id is not in the grant');
    const row = await admissionRow(payload.metadata!);
    assert.deepEqual({ ...row }, { auth_session_id: laptop.sessionId, user_id: s.member.id, revoked_at: null });
    assert.notEqual(claims((await s.join(laptop.browser)).token).metadata, payload.metadata, 'every join is a new admission');
  });

  test('the gate admits only the same cookie session and forwards nothing else to the SFU', async () => {
    const s = await scene('gate-binding');
    const laptop = await signedIn(s.member);
    const phone = await signedIn(s.member);
    const ownerSession = await signedIn(s.owner);
    const issued = await s.join(laptop.browser);
    const before = sfu.signals.length;

    // Another valid session of the same person, another person, no cookie, a foreign origin.
    await refused(signal(issued.token, phone.browser));
    await refused(signal(issued.token, ownerSession.browser));
    await refused(signal(issued.token, null));
    await refused(signal(issued.token, laptop.browser, { origin: 'https://evil.example' }), 403);
    // Forged, expired, foreign-metadata and wrong-room tokens.
    const payload = claims(issued.token);
    const base = { sub: payload.sub, metadata: payload.metadata, video: payload.video, exp: Math.floor(Date.now() / 1000) + 600 };
    await refused(signal(signed(base, 'another-secret-that-is-long-enough-for-hs256'), laptop.browser));
    await refused(signal(signed({ ...base, exp: Math.floor(Date.now() / 1000) - 60, nbf: Math.floor(Date.now() / 1000) - 120 }), laptop.browser));
    await refused(signal(signed({ ...base, metadata: randomBytes(16).toString('base64url') }), laptop.browser));
    await refused(signal(signed({ ...base, video: { ...payload.video, room: `live_${randomBytes(24).toString('base64url')}` } }), laptop.browser));
    await refused(signal(signed({ ...base, sub: claims((await s.join(ownerSession.browser)).token).sub }), laptop.browser));
    // Another admission of the same person and session: its identity is not this admission's.
    await refused(signal(signed({ ...base, sub: claims((await s.join(laptop.browser)).token).sub }), laptop.browser));
    await refused(signal(signed({ ...base, sub: `u_${Buffer.from(s.member.id).toString('base64url')}` }), laptop.browser));
    await refused(signal(issued.token, laptop.browser, { path: '/rtc/v2' }), 404);
    // The validate endpoints apply the same checks before any SFU request.
    const validations = sfu.validations.length;
    const denied = await phone.browser.request('GET', `/media/rtc/v1/validate?access_token=${encodeURIComponent(issued.token)}`, { origin: null });
    assert.equal(denied.status, 401);
    assert.equal(sfu.validations.length, validations);
    assert.equal(sfu.signals.length, before, 'no refused request reached the SFU');

    const socket = await opened(signal(issued.token, laptop.browser));
    const forwarded = sfu.signals.at(-1)!;
    assert.equal(forwarded.path, '/rtc/v1');
    assert.equal(forwarded.query.get('access_token'), issued.token);
    assert.equal(forwarded.query.get('join_request'), 'AAEC');
    assert.equal(forwarded.headers.cookie, undefined, 'the Flux cookie never reaches the SFU');
    socket.send(Buffer.from([1, 2, 3]));
    const echo = await new Promise<Buffer>((resolve) => socket.once('message', (data) => resolve(data as Buffer)));
    assert.deepEqual([...echo], [...Buffer.from('echo:'), 1, 2, 3]);
    const valid = await laptop.browser.request('GET', `/media/rtc/v1/validate?access_token=${encodeURIComponent(issued.token)}`, { origin: null });
    assert.equal(valid.status, 200);
    assert.equal(valid.text, 'success');
    assert.equal(new URL(sfu.validations.at(-1)!, 'http://sfu.invalid').pathname, '/rtc/v1/validate');
    // The v0 path is gated the same way.
    const v0 = await opened(signal(issued.token, laptop.browser, { path: '/rtc' }));
    assert.equal(sfu.signals.at(-1)!.path, '/rtc');
    socket.close();
    v0.close();
  });

  test('ordinary reconnect and an SFU-refreshed token work; lost project access is refused at the gate', async () => {
    const s = await scene('gate-reconnect');
    const laptop = await signedIn(s.member);
    const issued = await s.join(laptop.browser);
    const first = await opened(signal(issued.token, laptop.browser));
    first.terminate();
    const payload = claims(issued.token);
    const refreshed = signed({ sub: payload.sub, metadata: payload.metadata, video: payload.video, exp: Math.floor(Date.now() / 1000) + 600 });
    (await opened(signal(refreshed, laptop.browser))).close();
    (await opened(signal(issued.token, laptop.browser))).close();

    // Straight through the policy (the API container has no live media to rotate the room),
    // so the unchanged room isolates the gate's own project check.
    await grantProject({ kind: 'human', id: s.owner.id }, s.place.id,
      { principal: { kind: 'human', id: s.member.id }, role: 'denied' }, db);
    const before = sfu.signals.length;
    await refused(signal(refreshed, laptop.browser));
    assert.equal(sfu.signals.length, before);
  });

  test('sign-out revokes that session, closes its sockets and removes only its participant', async () => {
    const s = await scene('gate-signout');
    const laptop = await signedIn(s.member);
    const phone = await signedIn(s.member);
    const ownerSession = await signedIn(s.owner);
    const memberGrant = await s.join(laptop.browser);
    const ownerGrant = await s.join(ownerSession.browser);
    const memberSocket = await opened(signal(memberGrant.token, laptop.browser));
    const ownerSocket = await opened(signal(ownerGrant.token, ownerSession.browser));
    s.connect(s.member.id, memberGrant.token);
    s.connect(s.owner.id, ownerGrant.token);
    const upstream = sfu.signals.find((entry) => entry.query.get('access_token') === memberGrant.token)!.socket;
    const staleLaptop = copyOf(laptop.browser);
    const memberClosed = new Promise<void>((resolve) => memberSocket.once('close', () => resolve()));
    const payload = claims(memberGrant.token);
    const refreshed = signed({ sub: payload.sub, metadata: payload.metadata, video: payload.video, exp: Math.floor(Date.now() / 1000) + 600 });

    expectStatus(await laptop.browser.request('POST', '/api/auth/sign-out', { body: {} }), 200);
    await memberClosed;
    assert.ok((await admissionRow(payload.metadata!))?.revoked_at, 'revoked with the session deletion');
    await until(() => sfu.calls.includes(`remove:${s.session.roomId}:${payload.sub}`), 'the SFU participant removal');
    const calls = sfu.calls.filter((call) => call.startsWith(`drop:${s.session.roomId}:`) || call.startsWith(`remove:${s.session.roomId}:`));
    assert.deepEqual(calls, [`drop:${s.session.roomId}:${payload.sub}`, `remove:${s.session.roomId}:${payload.sub}`],
      'permissions are dropped before removal, for exactly the revoked admission');
    await until(() => upstream.readyState === WebSocket.CLOSED, 'the proxied SFU socket to close');
    assert.equal(ownerSocket.readyState, WebSocket.OPEN, 'another person stays connected');
    assert.deepEqual(sfu.rooms.get(s.session.roomId)?.map((participant) => participant.userId), [s.owner.id]);

    // Original and refreshed tokens are refused, with the old cookie and with another session's.
    const before = sfu.signals.length;
    await refused(signal(memberGrant.token, staleLaptop));
    await refused(signal(refreshed, staleLaptop));
    await refused(signal(refreshed, phone.browser));
    assert.equal(sfu.signals.length, before);
    // The person's other session still works with its own admission.
    const phoneGrant = await s.join(phone.browser);
    (await opened(signal(phoneGrant.token, phone.browser))).close();
    ownerSocket.close();
  });

  test('ending one session never removes the same person connected through another session', async () => {
    const s = await scene('gate-other-session');
    const laptop = await signedIn(s.member);
    const phone = await signedIn(s.member);
    const laptopGrant = await s.join(laptop.browser);
    const laptopSocket = await opened(signal(laptopGrant.token, laptop.browser));
    s.connect(s.member.id, laptopGrant.token);
    // The phone joins the same room: one SFU identity per admission, so both are participants.
    const phoneGrant = await s.join(phone.browser);
    assert.notEqual(claims(phoneGrant.token).sub, claims(laptopGrant.token).sub);
    const phoneSocket = await opened(signal(phoneGrant.token, phone.browser));
    s.connect(s.member.id, phoneGrant.token);
    const laptopClosed = new Promise<void>((resolve) => laptopSocket.once('close', () => resolve()));

    expectStatus(await laptop.browser.request('POST', '/api/auth/sign-out', { body: {} }), 200);
    await laptopClosed;
    await until(() => sfu.calls.includes(`remove:${s.session.roomId}:${claims(laptopGrant.token).sub}`), 'the laptop removal');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(phoneSocket.readyState, WebSocket.OPEN);
    assert.equal(sfu.calls.some((call) => call.endsWith(claims(phoneGrant.token).sub)), false, 'the phone participant is never addressed');
    assert.deepEqual(sfu.rooms.get(s.session.roomId)?.map((participant) => participant.identity), [claims(phoneGrant.token).sub]);
    phoneSocket.close();
  });

  test('revoking a session from another device and resetting the password end media too', async () => {
    const s = await scene('gate-revoke-reset');
    const laptop = await signedIn(s.member);
    const phone = await signedIn(s.member);
    const phoneGrant = await s.join(phone.browser);
    const phoneSocket = await opened(signal(phoneGrant.token, phone.browser));
    s.connect(s.member.id, phoneGrant.token);
    const phoneClosed = new Promise<void>((resolve) => phoneSocket.once('close', () => resolve()));
    assert.equal((await laptop.browser.request('DELETE', `/api/v1/sessions/${phone.sessionId}`)).status, 204);
    await phoneClosed;
    await until(() => sfu.calls.includes(`remove:${s.session.roomId}:${claims(phoneGrant.token).sub}`), 'removal after session revocation');
    await refused(signal(phoneGrant.token, phone.browser));

    const laptopGrant = await s.join(laptop.browser);
    const laptopSocket = await opened(signal(laptopGrant.token, laptop.browser));
    s.connect(s.member.id, laptopGrant.token);
    sfu.calls.length = 0;
    const laptopClosed = new Promise<void>((resolve) => laptopSocket.once('close', () => resolve()));
    expectStatus(await new Browser(gateUrl, publicOrigin).request('POST', '/api/auth/request-password-reset',
      { body: { email: s.member.email, redirectTo: `${publicOrigin}/reset-password` } }), 200);
    await until(() => resetMails.some((mail) => mail.to === s.member.email), 'the reset mail');
    const token = resetMails.filter((mail) => mail.to === s.member.email).at(-1)!.text.match(/reset-password\/([^?\s]+)/)![1]!;
    expectStatus(await new Browser(gateUrl, publicOrigin).request('POST', '/api/auth/reset-password',
      { body: { token, newPassword: 'a different long passphrase' } }), 200);
    await laptopClosed;
    await until(() => sfu.calls.includes(`remove:${s.session.roomId}:${claims(laptopGrant.token).sub}`), 'removal after password reset');
    assert.ok((await admissionRow(claims(laptopGrant.token).metadata!))?.revoked_at);
    await refused(signal(laptopGrant.token, laptop.browser));
  });

  test('reconciliation removes participants without a standing admission and keeps the rest', async () => {
    const s = await scene('gate-reconcile');
    const laptop = await signedIn(s.member);
    const ownerSession = await signedIn(s.owner);
    const ownerGrant = await s.join(ownerSession.browser);
    s.connect(s.owner.id, ownerGrant.token);
    const stranger = await person('gate-reconcile-stranger');
    const strangerAdmission = randomBytes(16).toString('base64url');
    const unknown = { userId: stranger.id, identity: participantIdentity(stranger.id, strangerAdmission), admissionId: strangerAdmission };
    const mismatched = { userId: s.member.id, identity: participantIdentity(s.member.id, randomBytes(16).toString('base64url')), admissionId: null };
    sfu.rooms.set(s.session.roomId, [...sfu.rooms.get(s.session.roomId)!, mismatched, unknown]);
    // A session that has expired no longer authorizes connected media either.
    const memberGrant = await s.join(laptop.browser);
    await pool.query(`UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [laptop.sessionId]);
    const expired = { userId: s.member.id, identity: claims(memberGrant.token).sub, admissionId: claims(memberGrant.token).metadata! };
    const removed: string[] = [];
    const revocation = admissionRevocation({ store: liveAdmissionStore(db), sockets: { closeAdmission: () => 0, openAdmissions: () => [] },
      media: { participantAdmissions: async () => [...sfu.rooms.get(s.session.roomId)!, expired],
        revokeParticipant: async (_roomId, identity) => { removed.push(identity); } },
      log: () => undefined });
    await revocation.reconcileRoom(s.session.roomId);
    assert.deepEqual(new Set(removed), new Set([mismatched.identity, unknown.identity, expired.identity]));
    assert.equal(removed.includes(claims(ownerGrant.token).sub), false);
  });

  test('the production adapter: one identity per admission, presence per person, leave removes all of them', async () => {
    const roomId = `live_${randomBytes(24).toString('base64url')}`;
    const [a, b, c] = [0, 1, 2].map(() => randomBytes(16).toString('base64url'));
    const ada = randomUUID();
    const ben = randomUUID();
    sfu.service.set(roomId, [
      { identity: participantIdentity(ada, a!), metadata: a!, state: 2, joinedAt: 100 },
      { identity: participantIdentity(ada, b!), metadata: b!, state: 2, joinedAt: 50 },
      { identity: participantIdentity(ben, c!), metadata: c!, state: 2, joinedAt: 70 },
      { identity: 'someone-else', metadata: '', state: 2, joinedAt: 10 },
    ]);
    const { token } = await realMedia.grant(roomId, ada, a!);
    assert.equal(claims(token).sub, participantIdentity(ada, a!));
    assert.match(claims(token).sub, /^u_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    // Two tabs or devices of one person appear once, with the earliest join.
    assert.deepEqual((await realMedia.participants(roomId)).sort((x, y) => x.userId.localeCompare(y.userId)),
      [{ userId: ada, joinedAt: new Date(50_000).toISOString() }, { userId: ben, joinedAt: new Date(70_000).toISOString() }]
        .sort((x, y) => x.userId.localeCompare(y.userId)));
    assert.equal(await realMedia.occupancy(roomId), 4, 'occupancy stays the raw participant count');
    assert.deepEqual((await realMedia.participantAdmissions(roomId)).map((participant) => participant.admissionId).sort(), [a, b, c].sort());

    // Revocation addresses exactly one identity: permissions first, then removal.
    sfu.serviceCalls.length = 0;
    await realMedia.revokeParticipant(roomId, participantIdentity(ada, a!));
    assert.deepEqual(sfu.serviceCalls, [`UpdateParticipant:${participantIdentity(ada, a!)}`, `RemoveParticipant:${participantIdentity(ada, a!)}`]);
    await realMedia.revokeParticipant(roomId, participantIdentity(ada, a!));
    assert.deepEqual(sfu.service.get(roomId)!.map((participant) => participant.identity).sort(),
      [participantIdentity(ada, b!), participantIdentity(ben, c!), 'someone-else'].sort(), 'an absent identity counts as done');

    // A person's own leave removes every identity of theirs, and nobody else.
    sfu.service.get(roomId)!.push({ identity: participantIdentity(ada, a!), metadata: a!, state: 1, joinedAt: 120 });
    await realMedia.removeParticipant(roomId, ada);
    assert.deepEqual(sfu.service.get(roomId)!.map((participant) => participant.identity).sort(), [participantIdentity(ben, c!), 'someone-else'].sort());
    await realMedia.removeParticipant(roomId, ada);
  });

  test('a held revocation never removes a newer session of the same person that joined the same room meanwhile', async () => {
    const s = await scene('gate-held-race');
    const laptop = await signedIn(s.member);
    const phone = await signedIn(s.member);
    const laptopGrant = await s.join(laptop.browser);
    const laptopAt = claims(laptopGrant.token);
    sfu.service.set(s.session.roomId, [{ identity: laptopAt.sub, metadata: laptopAt.metadata!, state: 2, joinedAt: 1 }]);
    const store = liveAdmissionStore(db);
    for (const path of ['session end', 'reconciliation'] as const) {
      let reached!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      // The production revocation and adapter, held after the participants were read (or,
      // on session end, where nothing is read) and before the SFU calls.
      const revocation = admissionRevocation({ store, sockets: { closeAdmission: () => 0, openAdmissions: () => [] }, log: () => undefined,
        media: {
          participantAdmissions: async (roomId) => { const snapshot = await realMedia.participantAdmissions(roomId); reached(); await released; return snapshot; },
          revokeParticipant: async (roomId, identity) => { reached(); await released; return realMedia.revokeParticipant(roomId, identity); },
        } });
      if (path === 'session end') expectStatus(await laptop.browser.request('POST', '/api/auth/sign-out', { body: {} }), 200);
      const pending = path === 'session end' ? revocation.sessionEnded(laptop.sessionId) : revocation.reconcileRoom(s.session.roomId);
      await holding;
      // The person's other session joins the same room while the removal is held.
      const phoneGrant = await s.join(phone.browser);
      const phoneAt = claims(phoneGrant.token);
      assert.notEqual(phoneAt.sub, laptopAt.sub);
      assert.notEqual(phoneAt.metadata, laptopAt.metadata);
      sfu.service.get(s.session.roomId)!.push({ identity: phoneAt.sub, metadata: phoneAt.metadata!, state: 2, joinedAt: 2 });
      sfu.serviceCalls.length = 0;
      release();
      await pending;
      assert.deepEqual(sfu.service.get(s.session.roomId)!.map((participant) => participant.identity), [phoneAt.sub], `${path}: the newer session stays`);
      assert.equal(sfu.serviceCalls.some((call) => call.endsWith(phoneAt.sub)), false, `${path}: the newer session is never addressed`);
      // The next path starts again from a revoked laptop participant beside the phone.
      sfu.service.set(s.session.roomId, [{ identity: laptopAt.sub, metadata: laptopAt.metadata!, state: 2, joinedAt: 1 }]);
    }
  });
});
