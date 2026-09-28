import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Conversation, LiveJoinGrant, LiveSession } from '@flux/contracts';
import { addMember, expectStatus, grant, person, project, workspace } from '../support/people.js';

interface MediaPage extends Window {
  LivekitClient?: { Room: new () => { connect(url: string, token: string): Promise<void>; state: string;
    engine: { token?: string }; disconnect(): Promise<void> } };
  LiveKitClient?: MediaPage['LivekitClient'];
  fluxRoom?: InstanceType<NonNullable<MediaPage['LivekitClient']>['Room']>;
  probeRoom?: InstanceType<NonNullable<MediaPage['LivekitClient']>['Room']>;
}

let browser: Browser | undefined;
after(async () => browser?.close());

const markerDir = process.env.FLUX_RESTART_MARKER_DIR;
if (!markerDir) throw new Error('FLUX_RESTART_MARKER_DIR is required');
const marker = (name: string) => `${markerDir}/${name}`;

async function waitForRestart(): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { if ((await readFile(marker('restarted'), 'utf8')).trim() === 'ok') return; }
    catch { /* The host has not restarted the SFU yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Host did not restart the pinned SFU after the ready marker');
}

function roomName(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as
    { exp: number; video: { room: string } };
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'token is still valid');
  return payload.video.room;
}

async function oldTokenRejected(page: Page, url: string, token: string): Promise<void> {
  const refused = page.waitForResponse((response) => response.url().includes('/rtc/validate') &&
    response.status() === 404, { timeout: 10_000 });
  await page.evaluate(({ url, token }) => {
    const w = window as MediaPage;
    const sdk = w.LivekitClient ?? w.LiveKitClient;
    if (!sdk) throw new Error('LiveKit browser SDK missing');
    w.probeRoom = new sdk.Room();
    void w.probeRoom.connect(url, token).catch(() => undefined);
  }, { url, token });
  await refused;
  assert.notEqual(await page.evaluate(() => (window as MediaPage).probeRoom?.state), 'connected');
  await page.evaluate(() => (window as MediaPage).probeRoom?.disconnect());
}

test('real SFU restart rotates a lost room; old original and refreshed tokens remain unusable',
  { timeout: 120_000 }, async () => {
    const owner = await person('sfu-restart-owner');
    const member = await person('sfu-restart-member');
    const ws = await workspace(owner, 'SFU restart');
    await addMember(owner, ws.id, member, 'member');
    const place = await project(owner, ws.id, 'Restart room', 'restricted');
    await grant(owner, place.id, member, 'viewer');
    const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/conversations`, {
      body: { body: 'Durable restart anchor', clientMessageId: randomUUID() },
    }), 201) as Conversation;
    const session = expectStatus(await owner.browser.request('POST', '/api/v1/live-sessions', {
      body: { context: { type: 'conversation', id: conversation.id }, clientSessionId: randomUUID() },
    }), 201) as LiveSession;
    const first = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const memberFirst = expectStatus(await member.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const oldRoom = roomName(first.token);
    assert.equal(roomName(memberFirst.token), oldRoom);
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const memberPage = await browser.newPage();
    await page.goto(first.mediaUrl.replace(/^ws/, 'http'));
    await memberPage.goto(first.mediaUrl.replace(/^ws/, 'http'));
    await page.addScriptTag({ path: '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js' });
    await memberPage.addScriptTag({ path: '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js' });
    const connect = async (clientPage: Page, url: string, token: string) => clientPage.evaluate(async ({ url, token }) => {
      const w = window as MediaPage;
      const sdk = w.LivekitClient ?? w.LiveKitClient;
      if (!sdk) throw new Error('Pinned LiveKit browser SDK missing');
      w.fluxRoom = new sdk.Room();
      await w.fluxRoom.connect(url, token);
    }, { url, token });
    await Promise.all([connect(page, first.mediaUrl, first.token),
      connect(memberPage, memberFirst.mediaUrl, memberFirst.token)]);
    assert.equal(await page.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
    assert.equal(await memberPage.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
    await page.waitForFunction((initial) => {
      const token = (window as MediaPage).fluxRoom?.engine.token;
      return typeof token === 'string' && token !== initial;
    }, first.token, { timeout: 15_000 });
    const refreshed = await page.evaluate(() => (window as MediaPage).fluxRoom?.engine.token);
    assert.ok(refreshed);
    assert.equal(roomName(refreshed), oldRoom);
    const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${place.id}/work`, {
      body: { title: 'Saved before media restart' },
    }), 201) as { id: string; title: string };

    await writeFile(marker('ready'), 'ok');
    await waitForRestart();
    const next = expectStatus(await owner.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    const memberNext = expectStatus(await member.browser.request('POST', `/api/v1/live-sessions/${session.id}/join`), 200) as LiveJoinGrant;
    assert.equal(next.session.generation, session.generation + 1);
    assert.notEqual(roomName(next.token), oldRoom);
    assert.equal(memberNext.session.generation, next.session.generation);
    assert.equal(roomName(memberNext.token), roomName(next.token));
    await page.evaluate(() => (window as MediaPage).fluxRoom?.disconnect());
    await memberPage.evaluate(() => (window as MediaPage).fluxRoom?.disconnect());
    await oldTokenRejected(page, first.mediaUrl, first.token);
    await oldTokenRejected(page, first.mediaUrl, refreshed);
    await Promise.all([connect(page, next.mediaUrl, next.token),
      connect(memberPage, memberNext.mediaUrl, memberNext.token)]);
    assert.equal(await page.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
    assert.equal(await memberPage.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
    const saved = expectStatus(await owner.browser.request('GET', `/api/v1/work/${work.id}`), 200) as { title: string };
    assert.equal(saved.title, work.title);
    console.log(JSON.stringify({ oldRoom, newRoom: roomName(next.token), generation: next.session.generation,
      originalRejected: true, refreshedRejected: true, remainingClientsConnected: 2, workSurvived: work.id }));
  });
