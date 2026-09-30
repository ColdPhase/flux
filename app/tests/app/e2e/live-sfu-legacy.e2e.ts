import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { chromium, type Browser as ChromiumBrowser, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { Browser } from '../support/http.js';
import { mediaPage, openRoom, tokenClaims, type MediaPage } from '../support/live-sfu.js';
import { addMember, expectStatus, person, project, workspace } from '../support/people.js';

/**
 * API cutover (#128): a participant that joined the pinned SFU with a pre-#128 grant (identity
 * `u_<base64url(userId)>`, no admission metadata) stays connected when only the API is
 * upgraded. Reconciliation must retire it by that exact identity while an admitted session in
 * the same room stays. The old grant is signed here with the SFU keys and used directly on the
 * private signal port, as the old API's clients did; run only through scripts/check_live_sfu.sh.
 */
let chromiumBrowser: ChromiumBrowser | undefined;
after(async () => chromiumBrowser?.close());
const privateSignal = process.env.FLUX_LIVEKIT_PRIVATE_URL;
const apiKey = process.env.FLUX_LIVEKIT_API_KEY;
const apiSecret = process.env.FLUX_LIVEKIT_API_SECRET;
const markerDir = process.env.FLUX_CUTOVER_MARKER_DIR;
if (!privateSignal || !apiKey || !apiSecret || !markerDir)
  throw new Error('FLUX_LIVEKIT_PRIVATE_URL, FLUX_LIVEKIT_API_KEY, FLUX_LIVEKIT_API_SECRET and FLUX_CUTOVER_MARKER_DIR are required');

/** Hands a step to scripts/check_live_sfu.sh, which stops or starts the API, and waits for it. */
async function step(done: string, next: string): Promise<void> {
  await writeFile(`${markerDir}/${done}`, 'ok');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await readFile(`${markerDir}/${next}`, 'utf8')).trim() === 'ok') return; }
    catch { /* The host has not finished the step yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The host did not complete ${next}`);
}

/** The grant shape main issued before #128: one identity per person and no metadata. */
function legacyGrant(userId: string, room: string): { identity: string; token: string } {
  const identity = `u_${Buffer.from(userId, 'utf8').toString('base64url')}`;
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: apiKey, sub: identity, nbf: now - 5, exp: now + 600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } })}`;
  return { identity, token: `${body}.${createHmac('sha256', apiSecret!).update(body).digest('base64url')}` };
}

/** The SFU's own participant list, through its room service on the private network. */
async function sfuParticipants(room: string): Promise<{ identity: string; tracks?: unknown[] }[]> {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: apiKey, sub: 'flux-cutover-test', nbf: now - 5, exp: now + 60,
    video: { room, roomAdmin: true } })}`;
  const response = await fetch(`${privateSignal!.replace(/^ws/, 'http')}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${body}.${createHmac('sha256', apiSecret!).update(body).digest('base64url')}` },
    body: JSON.stringify({ room }) });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { participants?: { identity: string; tracks?: unknown[] }[] }).participants ?? [];
}

async function state(page: Page) { return page.evaluate(() => (window as MediaPage).fluxRoom?.state); }

test('reconciliation retires a participant connected with a pre-#128 grant and keeps an admitted one',
  { timeout: 240_000 }, async () => {
    const owner = await person('sfu-legacy-owner');
    const member = await person('sfu-legacy-member');
    const ws = await workspace(owner, 'SFU cutover');
    await addMember(owner, ws.id, member, 'member');
    const place = await project(owner, ws.id, 'Cutover room', 'workspace');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Cutover anchor', clientMessageId: randomUUID() } }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() } }), 201) as LiveSession;
    const ownerGrant = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const room = tokenClaims(ownerGrant.token).video.room;

    chromiumBrowser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const ownerPage = await mediaPage(chromiumBrowser, owner.browser);
    await openRoom(ownerPage, ownerGrant.mediaUrl, ownerGrant.token);

    // The member signs out of Flux; their old connection knows nothing of it.
    expectStatus(await member.browser.request('POST', '/api/auth/sign-out', { body: {} }), 200);
    const legacy = legacyGrant(member.id, room);
    // A loopback page (a secure context, so it can capture audio) with no Flux cookie; the old
    // client signals straight to the SFU, as clients of the old API did.
    const legacyPage = await mediaPage(chromiumBrowser, new Browser());

    // The old API is gone and the new one not yet started: nothing reconciles meanwhile.
    await step('ready', 'api-stopped');
    const outcome = await legacyPage.evaluate(async ({ url, token }) => {
      const w = window as MediaPage;
      const sdk = w.LivekitClient ?? w.LiveKitClient;
      if (!sdk) throw new Error('LiveKit SDK missing');
      const room = new sdk.Room();
      w.fluxRoom = room;
      room.on('disconnected', (reason) => { w.fluxEvents = [`disconnected:${String(reason)}`]; });
      await room.connect(url, token);
      await room.localParticipant.publishTrack(await sdk.createLocalAudioTrack());
      return room.state;
    }, { url: privateSignal, token: legacy.token });
    assert.equal(outcome, 'connected');
    const before = await sfuParticipants(room);
    const held = before.find((participant) => participant.identity === legacy.identity);
    assert.ok(held && (held.tracks?.length ?? 0) > 0, 'the old participant is connected and publishing audio');
    await step('legacy-connected', 'api-started');
    const startedAt = Date.now();

    // The new API's reconciliation (listener reconnect / periodic pass) retires it by its identity.
    const deadline = Date.now() + 45_000;
    let remaining = (await sfuParticipants(room)).map((participant) => participant.identity);
    while (remaining.includes(legacy.identity) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      remaining = (await sfuParticipants(room)).map((participant) => participant.identity);
    }
    const retiredMs = Date.now() - startedAt;
    assert.equal(remaining.includes(legacy.identity), false, 'the pre-#128 participant was retired');
    await legacyPage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 30_000 });
    // DisconnectReason.PARTICIPANT_REMOVED (4): the SFU removed it on Flux's request, not a timeout.
    const legacyReason = await legacyPage.evaluate(() => (window as MediaPage).fluxEvents?.[0]);
    assert.equal(legacyReason, 'disconnected:4');
    assert.deepEqual(remaining, [tokenClaims(ownerGrant.token).sub], 'only the admitted participant remains in the SFU');
    await ownerPage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'connected', undefined, { timeout: 30_000 });
    const ownerEvents = await ownerPage.evaluate(() => [...((window as MediaPage).fluxEvents ?? [])]);
    assert.equal(await state(ownerPage), 'connected', 'the admitted session in the same room stays');
    const presence = expectStatus(await owner.browser.request('GET', `/api/v1/live-sessions/${session.id}`), 200) as LiveSession;
    assert.deepEqual(presence.participants?.map((participant) => participant.userId), [owner.id]);
    console.log(JSON.stringify({ room, legacyIdentity: legacy.identity, legacyPublishedTracks: held.tracks?.length, retiredAfterApiStartMs: retiredMs, legacyReason,
      ownerSawLegacy: ownerEvents.filter((event) => event.endsWith(legacy.identity)),
      admittedStillConnected: true }));
  });
