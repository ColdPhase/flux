import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { chromium, type Browser as ChromiumBrowser, type Page } from 'playwright';
import { createDatabase } from '@flux/db';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

/**
 * The public Flux API, two Chromium LiveKit clients, and the pinned self-hosted SFU
 * participate in one revocation. This deliberately does not mock the media port.
 * Run only through scripts/check_live_sfu.sh; the ordinary PR suite has no SFU.
 */
const sdkPath = '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js';
let browser: ChromiumBrowser | undefined;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for signed LiveKit webhook observation');
const { pool: webhookPool } = createDatabase(connectionString);
after(async () => { await browser?.close(); await webhookPool.end(); });

interface BrowserRoom {
  connect(url: string, token: string, options?: { maxRetries?: number }): Promise<void>;
  disconnect(): Promise<void>;
  state: string;
  engine: { token?: string };
}

interface MediaPage extends Window {
  LivekitClient?: { Room: new () => BrowserRoom };
  LiveKitClient?: { Room: new () => BrowserRoom };
  fluxRoom?: BrowserRoom;
  probeRoom?: BrowserRoom;
}

async function openRoom(page: Page, url: string, token: string): Promise<void> {
  // Signaling begins with fetch before the WebSocket upgrade. A same-origin page
  // avoids the opaque `about:blank` origin's CORS rejection in Chromium.
  await page.goto(url.replace(/^ws/, 'http'));
  await page.addScriptTag({ path: sdkPath });
  await page.evaluate(async ({ url, token }) => {
    const w = window as MediaPage;
    const sdk = w.LivekitClient ?? w.LiveKitClient;
    if (!sdk) throw new Error('Pinned LiveKit browser SDK did not expose its UMD global');
    const room = new sdk.Room();
    w.fluxRoom = room;
    await room.connect(url, token);
  }, { url, token });
  assert.equal(await page.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
}

async function refreshedToken(page: Page, original: string): Promise<string> {
  await page.waitForFunction((first) => {
    const current = (window as MediaPage).fluxRoom?.engine.token;
    return typeof current === 'string' && current !== first;
  }, original, { timeout: 15_000 });
  const token = await page.evaluate(() => (window as MediaPage).fluxRoom?.engine.token);
  assert.ok(token && token !== original, 'the token was actually refreshed by the SFU');
  return token;
}

function roomName(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    exp: number; video: { room: string };
  };
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'token is still valid when tested');
  assert.match(payload.video.room, /^live_[A-Za-z0-9_-]{32}$/);
  return payload.video.room;
}

async function failsToReconnect(page: Page, url: string, token: string): Promise<string> {
  // The SDK retries failed signaling for a long time. Observe the SFU's own
  // rejection instead of waiting for the client retry policy to exhaust.
  const refused = page.waitForResponse((response) => response.url().includes('/rtc/validate') &&
    response.status() === 404, { timeout: 10_000 });
  await page.evaluate(({ url, token }) => {
    const w = window as MediaPage;
    const sdk = w.LivekitClient ?? w.LiveKitClient;
    if (!sdk) throw new Error('LiveKit SDK missing');
    const room = new sdk.Room();
    w.probeRoom = room;
    void room.connect(url, token).catch(() => undefined);
  }, { url, token });
  const response = await refused;
  assert.notEqual(await page.evaluate(() => (window as MediaPage).probeRoom?.state), 'connected');
  await page.evaluate(() => (window as MediaPage).probeRoom?.disconnect());
  return `HTTP ${response.status()} ${new URL(response.url()).pathname}`;
}

test('Flux revocation retires the real SFU room, rejects original and refreshed grants, and rejoins a remaining member',
  { timeout: 120_000 }, async () => {
    const owner = await person('sfu-owner');
    const revoked = await person('sfu-revoked');
    const ws = await workspace(owner, 'SFU cutoff');
    await addMember(owner, ws.id, revoked, 'member');
    const place = await project(owner, ws.id, 'Restricted room', 'restricted');
    await grant(owner, place.id, revoked, 'viewer');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Live room anchor', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const ownerGrant = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const revokedGrant = expectStatus(await revoked.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    assert.equal(ownerGrant.mediaUrl, process.env.FLUX_LIVEKIT_WS_URL);
    const oldRoom = roomName(revokedGrant.token);
    assert.equal(roomName(ownerGrant.token), oldRoom);

    browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const ownerPage = await browser.newPage();
    const revokedPage = await browser.newPage();
    await Promise.all([
      openRoom(ownerPage, ownerGrant.mediaUrl, ownerGrant.token),
      openRoom(revokedPage, revokedGrant.mediaUrl, revokedGrant.token),
    ]);
    const fresh = await refreshedToken(revokedPage, revokedGrant.token);
    assert.equal(roomName(fresh), oldRoom, 'the SFU-refreshed JWT still names the old room');

    const until = Date.now() + 10_000;
    let connected: LiveSession | null = null;
    while (Date.now() < until) {
      connected = expectStatus(await owner.browser.request('GET', `/api/v1/live-sessions/${session.id}`), 200) as LiveSession;
      if (connected.participants?.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(new Set(connected?.participants?.map((p) => p.userId)), new Set([owner.id, revoked.id]));
    // The pinned SFU must deliver a real signed presence webhook through the
    // private Compose network; a synthetic SDK signature test alone is not enough.
    let delivered = 0;
    const webhookDeadline = Date.now() + 10_000;
    while (Date.now() < webhookDeadline) {
      const result = await webhookPool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM live_webhook_events WHERE session_id = $1', [session.id]);
      delivered = result.rows[0]?.count ?? 0;
      if (delivered > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(delivered > 0, 'signed webhook from the actual SFU reached the current session');
    const discovered = expectStatus(await owner.browser.request('GET',
      `/api/v1/projects/${place.id}/live-sessions`), 200) as { items: LiveSession[] };
    assert.equal(discovered.items.find((item) => item.id === session.id)?.participants?.length, 2);
    assert.equal(JSON.stringify(discovered).includes(oldRoom), false, 'discovery does not disclose the media room ID');

    // A successful policy mutation must already have deleted the old SFU room.
    await grant(owner, place.id, revoked, 'denied');
    const hidden = await revoked.browser.request('GET', `/api/v1/projects/${place.id}/live-sessions`);
    assert.equal(hidden.status, 404, hidden.text);
    await Promise.all([ownerPage, revokedPage].map((page) => page.waitForFunction(
      () => (window as MediaPage).fluxRoom?.state === 'disconnected', undefined, { timeout: 15_000 })));
    const denied = await revoked.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`);
    assert.equal(denied.status, 404, denied.text);
    assert.equal((denied.json as { code: string }).code, 'PROJECT_NOT_FOUND');

    const originalFailure = await failsToReconnect(revokedPage, revokedGrant.mediaUrl, revokedGrant.token);
    const refreshedFailure = await failsToReconnect(revokedPage, revokedGrant.mediaUrl, fresh);
    assert.match(originalFailure, /room|not found|404|connect/i);
    assert.match(refreshedFailure, /room|not found|404|connect/i);

    const next = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    assert.equal(next.session.generation, session.generation + 1);
    assert.notEqual(roomName(next.token), oldRoom);
    await openRoom(ownerPage, next.mediaUrl, next.token);

    // Leave is idempotent against the real SFU: the second request confirms
    // absence instead of turning a completed disconnect into an API failure.
    expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/leave`), 204);
    await ownerPage.waitForFunction(() => (window as MediaPage).fluxRoom?.state === 'disconnected',
      undefined, { timeout: 15_000 });
    expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/leave`), 204);

    // Media departure never changes ordinary durable project work.
    const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Follow up after the live room' },
    }), 201) as { id: string; title: string };
    const saved = expectStatus(await owner.browser.request('GET', `/api/v1/work/${work.id}`), 200) as { title: string };
    assert.equal(saved.title, work.title);
    console.log(JSON.stringify({ oldRoom, newRoom: roomName(next.token), generation: next.session.generation,
      oldTokenRejected: originalFailure, refreshedTokenRejected: refreshedFailure,
      remainingRejoined: true, repeatedLeave: 204, signedWebhooks: delivered, workSurvived: work.id }));
  });
