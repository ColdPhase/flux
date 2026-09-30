import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import WebSocket from 'ws';
import { chromium, type Browser as ChromiumBrowser, type Page, type WebSocket as PageSocket } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { Browser, publicOrigin } from '../support/http.js';
import { mediaPage, openRoom, refreshedToken, refusedAtGate, roomName, tokenClaims, type MediaPage } from '../support/live-sfu.js';
import { addMember, expectStatus, person, project, secondSession, workspace } from '../support/people.js';

/**
 * Sign-out and session revocation against the pinned self-hosted SFU (#128): real Chromium
 * LiveKit clients with fake audio, the full Flux API and its `/media` signaling gate. Run only
 * through scripts/check_live_sfu.sh. The browsers share the SFU's media network, as a person's
 * browser reaches the published ICE ports, but not its signaling port.
 */
let chromiumBrowser: ChromiumBrowser | undefined;
after(async () => chromiumBrowser?.close());
const directSignal = process.env.FLUX_LIVEKIT_DIRECT_URL;
if (!directSignal) throw new Error('FLUX_LIVEKIT_DIRECT_URL is required');

/** Every signaling socket a page opens, with the frames it received. */
function recordSockets(page: Page) {
  const sockets: { url: string; received: number; socket: PageSocket }[] = [];
  page.on('websocket', (socket) => {
    const entry = { url: socket.url(), received: 0, socket };
    socket.on('framereceived', () => { entry.received += 1; });
    sockets.push(entry);
  });
  return sockets;
}

function copyOf(client: Browser): Browser {
  const copy = new Browser();
  for (const [name, value] of client.cookies) copy.cookies.set(name, value);
  return copy;
}

async function state(page: Page) { return page.evaluate(() => (window as MediaPage).fluxRoom?.state); }
async function events(page: Page) { return page.evaluate(() => [...((window as MediaPage).fluxEvents ?? [])]); }
/** Waits until `page`'s room records `event` again after its first `seen` records. */
async function eventAfter(page: Page, event: string, seen: number, timeout = 30_000) {
  await page.waitForFunction(({ event, seen }) => ((window as MediaPage).fluxEvents ?? []).slice(seen).includes(event),
    { event, seen }, { timeout });
}
/** The SFU identity of a grant: one per admission (`u_<user>.<admission>`, #128). */
const identity = (grant: LiveJoinGrant) => tokenClaims(grant.token).sub;

async function publishAudio(page: Page) {
  await page.evaluate(async () => {
    const w = window as MediaPage;
    const sdk = w.LivekitClient ?? w.LiveKitClient;
    const track = await sdk!.createLocalAudioTrack();
    await w.fluxRoom!.localParticipant.publishTrack(track);
  });
}

/** Replays a captured signaling request as a raw client: returns the HTTP status and SFU frames seen. */
function replay(url: string, cookieFrom: Browser | null): Promise<{ status: number; frames: number }> {
  const headers: Record<string, string> = { origin: publicOrigin };
  if (cookieFrom?.cookies.size) headers.cookie = cookieFrom.cookieHeader();
  const gateUrl = new URL(url);
  const target = `${new URL('/', process.env.FLUX_API_URL ?? 'http://api:8080').origin.replace(/^http/, 'ws')}${gateUrl.pathname}${gateUrl.search}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { headers });
    let frames = 0;
    socket.on('message', () => { frames += 1; });
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode ?? 0, frames }); socket.terminate(); });
    socket.once('open', () => setTimeout(() => { resolve({ status: 101, frames }); socket.terminate(); }, 1000));
    socket.once('error', reject);
  });
}

async function directConnectFails(token: string): Promise<string> {
  const outcome = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`${directSignal}/rtc/v1?access_token=${encodeURIComponent(token)}`, { handshakeTimeout: 3000 });
    socket.once('open', () => { socket.terminate(); resolve('open'); });
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(`http ${response.statusCode}`); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
  assert.notEqual(outcome, 'open', 'the SFU signaling port must not accept a browser-network connection');
  assert.doesNotMatch(outcome, /^http /, 'the SFU signaling port must not even answer HTTP from the browser network');
  return outcome;
}

test('sign-out ends the signed-out session media, refuses its grants at the gate and leaves others connected',
  { timeout: 180_000 }, async () => {
    const owner = await person('sfu-signout-owner');
    const member = await person('sfu-signout-member');
    const phone = await secondSession(member);
    const ws = await workspace(owner, 'SFU sign-out');
    await addMember(owner, ws.id, member, 'member');
    const place = await project(owner, ws.id, 'Sign-out room', 'workspace');
    const anchor = async (body: string) => ({ type: 'conversation' as const, id: (expectStatus(await owner.browser.request('POST',
      `/api/v1/projects/${place.id}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation).id });
    const start = async (body: string) => expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: await anchor(body), clientSessionId: randomUUID() } }), 201) as LiveSession;
    const room = await start('Sign-out room anchor');
    const otherRoom = await start('Another room of the same person');
    const join = async (client: Browser, sessionId = room.id) =>
      expectStatus(await client.request('POST', `/api/v1/live-sessions/${sessionId}/join`), 200) as LiveJoinGrant;

    const ownerGrant = await join(owner.browser);
    const laptopGrant = await join(member.browser);
    const phoneGrant = await join(phone.browser, otherRoom.id);
    // A third session of the same person in the same room: its own admission and identity.
    const tablet = await secondSession(member);
    const tabletGrant = await join(tablet.browser);
    assert.notEqual(identity(tabletGrant), identity(laptopGrant));
    assert.equal(laptopGrant.mediaUrl, `${publicOrigin.replace(/^http/, 'ws')}/media`);

    // (c) The SFU's signaling port is private: nothing on the browser network reaches it.
    const direct = await directConnectFails(laptopGrant.token);

    chromiumBrowser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const ownerPage = await mediaPage(chromiumBrowser, owner.browser);
    const laptopPage = await mediaPage(chromiumBrowser, member.browser);
    const phonePage = await mediaPage(chromiumBrowser, phone.browser);
    const tabletPage = await mediaPage(chromiumBrowser, tablet.browser);
    const laptopSockets = recordSockets(laptopPage);
    const directFromPage = await laptopPage.evaluate((url) => new Promise<string>((resolve) => {
      const socket = new WebSocket(`${url}/rtc/v1`);
      socket.onopen = () => { socket.close(); resolve('open'); };
      socket.onerror = () => resolve('error');
    }), directSignal);
    assert.equal(directFromPage, 'error', 'Chromium cannot open the SFU signaling port either');

    await Promise.all([openRoom(ownerPage, ownerGrant.mediaUrl, ownerGrant.token),
      openRoom(laptopPage, laptopGrant.mediaUrl, laptopGrant.token),
      openRoom(phonePage, phoneGrant.mediaUrl, phoneGrant.token)]);
    await publishAudio(laptopPage);
    await ownerPage.waitForFunction((who) => (window as MediaPage).fluxEvents?.includes(`track:${who}`),
      identity(laptopGrant), { timeout: 15_000 });
    // The tablet joins the same room and publishes too: both sessions of one person coexist.
    await openRoom(tabletPage, tabletGrant.mediaUrl, tabletGrant.token);
    await publishAudio(tabletPage);
    await ownerPage.waitForFunction((who) => (window as MediaPage).fluxEvents?.includes(`track:${who}`),
      identity(tabletGrant), { timeout: 15_000 });
    assert.equal(await state(laptopPage), 'connected', 'the second session did not replace the first');
    const refreshed = await refreshedToken(laptopPage, laptopGrant.token);
    assert.equal(tokenClaims(refreshed).metadata, tokenClaims(laptopGrant.token).metadata, 'SFU refresh keeps the admission id');

    // (e) Ordinary resume and full reconnect pass the gate with the current cookie.
    for (const scenario of ['signal-reconnect', 'full-reconnect']) {
      const before = laptopSockets.length;
      const seen = (await events(laptopPage)).length;
      await laptopPage.evaluate((name) => (window as MediaPage).fluxRoom!.simulateScenario(name), scenario);
      await eventAfter(laptopPage, 'state:connected', seen);
      assert.equal(await state(laptopPage), 'connected', scenario);
      assert.ok(laptopSockets.length > before, `${scenario} opened a new signaling socket through the gate`);
    }
    // After the full reconnect the receiver hears the republished audio again.
    await ownerPage.waitForFunction((who) => (window as MediaPage).fluxEvents!.filter((event) => event === `track:${who}`).length >= 1,
      identity(laptopGrant), { timeout: 15_000 });
    // Apart from the refused direct probe above, the client signaled only through the gate.
    const gate = `${publicOrigin.replace(/^http/, 'ws')}/media/rtc`;
    assert.deepEqual(laptopSockets.filter((entry) => !entry.url.startsWith(gate)).map((entry) => new URL(entry.url).host), ['livekit:7880']);
    const captured = laptopSockets.filter((entry) => entry.url.startsWith(gate)).map((entry) => entry.url);
    assert.ok(captured.length >= 3, 'first connect, resume and full reconnect');
    const stale = copyOf(member.browser);

    // (a) Sign out while audio is publishing.
    const ownerSeen = (await events(ownerPage)).length;
    const signedOutAt = Date.now();
    const socketsAtSignOut = laptopSockets.length;
    expectStatus(await member.browser.request('POST', '/api/auth/sign-out', { body: {} }), 200);
    await eventAfter(ownerPage, `left:${identity(laptopGrant)}`, ownerSeen);
    const receiverSawLeaveMs = Date.now() - signedOutAt;
    await laptopPage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 60_000 });
    const senderDisconnectedMs = Date.now() - signedOutAt;

    // (b) Every reconnect the signed-out client tried after sign-out got no SFU frame.
    const afterSignOut = laptopSockets.slice(socketsAtSignOut);
    assert.ok(afterSignOut.every((entry) => entry.received === 0), 'no participant list or metadata reached the signed-out client');
    // Original and refreshed tokens, replayed as captured first-connect, resume and full-reconnect
    // requests with the stolen cookie, with the same person's other session, and with none.
    const replays: string[] = [];
    for (const url of captured) {
      for (const [label, cookie] of [['signed-out cookie', stale], ['other session', phone.browser], ['no cookie', null]] as const) {
        const result = await replay(url, cookie);
        assert.equal(result.status, 401, `${label}: ${url.slice(0, 60)}`);
        assert.equal(result.frames, 0);
      }
      const withRefreshed = new URL(url);
      withRefreshed.searchParams.set('access_token', refreshed);
      assert.deepEqual(await replay(withRefreshed.toString(), stale), { status: 401, frames: 0 });
      replays.push(new URL(url).pathname);
    }
    const staleProbe = await mediaPage(chromiumBrowser, stale);
    const originalRefused = await refusedAtGate(staleProbe, laptopGrant.mediaUrl, laptopGrant.token);
    const refreshedRefused = await refusedAtGate(staleProbe, laptopGrant.mediaUrl, refreshed);
    await directConnectFails(refreshed);

    // (d) The other person and the same person's other session were never touched.
    assert.equal(await state(ownerPage), 'connected');
    assert.equal(await state(phonePage), 'connected');
    assert.equal(await state(tabletPage), 'connected', 'the same-room session of the same person stays');
    assert.equal((await events(ownerPage)).includes(`left:${identity(tabletGrant)}`), false);
    assert.equal((await events(tabletPage)).some((event) => event === 'state:disconnected'), false);
    assert.equal((await events(phonePage)).some((event) => event === 'state:disconnected'), false);
    // The other session joins the signed-out session's room with its own admission.
    const phoneHere = await join(phone.browser);
    const phonePageHere = await mediaPage(chromiumBrowser, phone.browser);
    const ownerBeforePhone = (await events(ownerPage)).length;
    await openRoom(phonePageHere, phoneHere.mediaUrl, phoneHere.token);
    await publishAudio(phonePageHere);
    await eventAfter(ownerPage, `track:${identity(phoneHere)}`, ownerBeforePhone, 15_000);

    // Two sessions of one person publish in one room; presence shows the person once.
    const members = async () => ((expectStatus(await owner.browser.request('GET', `/api/v1/live-sessions/${room.id}`), 200) as LiveSession)
      .participants ?? []).filter((participant) => participant.userId === member.id).length;
    assert.equal(await members(), 1, 'the tablet and phone sessions are one person');
    // Leave on the tablet ends only the tablet: the phone session in the same room stays.
    const ownerBeforeLeave = (await events(ownerPage)).length;
    expectStatus(await tablet.browser.request('POST', `/api/v1/live-sessions/${room.id}/leave`), 204);
    await tabletPage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 30_000 });
    await eventAfter(ownerPage, `left:${identity(tabletGrant)}`, ownerBeforeLeave);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(await state(phonePageHere), 'connected', 'Leave on one device keeps the other');
    assert.equal((await events(ownerPage)).slice(ownerBeforeLeave).includes(`left:${identity(phoneHere)}`), false);
    assert.equal(await members(), 1);
    expectStatus(await tablet.browser.request('POST', `/api/v1/live-sessions/${room.id}/leave`), 204);

    // Session revocation from another device ends that device's media the same way.
    const phoneSockets = recordSockets(phonePage);
    expectStatus(await phone.browser.request('GET', '/api/v1/me'), 200);
    const signedInAgain = await secondSession(member);
    assert.equal((await signedInAgain.browser.request('DELETE', `/api/v1/sessions/${phone.sessionId}`)).status, 204);
    await phonePageHere.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 60_000 });
    await phonePage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 60_000 });
    assert.ok(phoneSockets.every((entry) => entry.received === 0));
    assert.equal(await state(ownerPage), 'connected', 'the other person is still connected');

    // (f) A join burst hits the existing per-person rate limit; others are unaffected.
    const burst = await person('sfu-signout-burst');
    await addMember(owner, ws.id, burst, 'member');
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await burst.browser.request('POST', `/api/v1/live-sessions/${room.id}/join`);
      statuses.push(response.status);
      if (response.status === 429) retryAfter = response.headers.get('retry-after');
    }
    assert.deepEqual(statuses, [...Array(20).fill(200), 429]);
    assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60);
    expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${room.id}/join`), 200);

    // Saved work is untouched by media revocation.
    const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Follow up after sign-out' } }), 201) as { id: string; title: string };
    assert.equal((expectStatus(await owner.browser.request('GET', `/api/v1/work/${work.id}`), 200) as { title: string }).title, work.title);
    console.log(JSON.stringify({ room: roomName(ownerGrant.token), directSfu: direct, receiverSawLeaveMs, senderDisconnectedMs,
      signedOutReconnectSockets: afterSignOut.length, replayedPaths: replays, originalRefused, refreshedRefused,
      otherSessionAndPersonConnected: true, sameRoomSessionConnected: true, leaveEndedOnlyThisDevice: true, burst: statuses.join(','), retryAfter, workSurvived: work.id }));
  });
