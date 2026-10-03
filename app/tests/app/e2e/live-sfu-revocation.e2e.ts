import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { chromium, type Browser as ChromiumBrowser } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { pool as webhookPool } from '../support/db.js';
import { publicOrigin } from '../support/http.js';
import { mediaPage, openRoom, refreshedToken, refusedAtGate, roomName, type MediaPage } from '../support/live-sfu.js';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

/**
 * The public Flux API, two Chromium LiveKit clients, and the pinned self-hosted SFU
 * participate in one revocation. This deliberately does not mock the media port.
 * Run only through scripts/check_live_sfu.sh; the ordinary PR suite has no SFU.
 */
// Signed LiveKit webhook observation reads rows through the shared pool, which support/db ends.
let browser: ChromiumBrowser | undefined;
after(async () => { await browser?.close(); });

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
    // Browsers get the Flux signaling gate, never the SFU address (#128).
    assert.equal(ownerGrant.mediaUrl, `${publicOrigin.replace(/^http/, 'ws')}/media`);
    const oldRoom = roomName(revokedGrant.token);
    assert.equal(roomName(ownerGrant.token), oldRoom);

    browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const ownerPage = await mediaPage(browser, owner.browser);
    const revokedPage = await mediaPage(browser, revoked.browser);
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

    // The gate refuses both before the SFU: project access is gone (and the room retired).
    const originalFailure = await refusedAtGate(revokedPage, revokedGrant.mediaUrl, revokedGrant.token);
    const refreshedFailure = await refusedAtGate(revokedPage, revokedGrant.mediaUrl, fresh);

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
