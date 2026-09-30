import assert from 'node:assert/strict';
import { createConnection, createServer, type Server } from 'node:net';
import type { Browser as ChromiumBrowser, Page } from 'playwright';
import { apiUrl, publicOrigin, type Browser } from './http.js';

/** The locked browser SDK of tooling/live-sfu-test, loaded from disk into each page. */
export const sdkPath = '/opt/live-sfu/node_modules/livekit-client/dist/livekit-client.umd.js';

export interface BrowserRoom {
  connect(url: string, token: string, options?: { maxRetries?: number }): Promise<void>;
  disconnect(): Promise<void>;
  simulateScenario(scenario: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): BrowserRoom;
  state: string;
  engine: { token?: string };
  localParticipant: { publishTrack(track: unknown): Promise<unknown> };
  remoteParticipants: Map<string, unknown>;
}

export interface MediaPage extends Window {
  LivekitClient?: { Room: new () => BrowserRoom; createLocalAudioTrack(): Promise<unknown> };
  LiveKitClient?: MediaPage['LivekitClient'];
  fluxRoom?: BrowserRoom;
  probeRoom?: BrowserRoom;
  /** What this page's room observed, in order: `joined:<identity>`, `left:<identity>`, `track:<identity>`, `state:<state>`. */
  fluxEvents?: string[];
}

let forwarder: Server | undefined;

/**
 * Browsers open the public origin, a loopback address inside the test container, as a person
 * does on the host. This forwards it to the API container, so cookies, the Origin check and
 * the `/media` signaling gate behave as in a deployment (#128).
 */
export async function forwardPublicOrigin(): Promise<void> {
  if (forwarder) return;
  const listen = new URL(publicOrigin);
  const upstream = new URL(apiUrl);
  const server = createServer((client) => {
    const remote = createConnection(Number(upstream.port || 80), upstream.hostname);
    client.pipe(remote).pipe(client);
    const end = () => { client.destroy(); remote.destroy(); };
    client.on('error', end);
    remote.on('error', end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(listen.port || 80), listen.hostname, () => resolve());
  });
  server.unref();
  forwarder = server;
}

/**
 * A browser context holding exactly `client`'s Flux cookies, on a small page of the public
 * origin with the SDK loaded. Same-origin signaling then carries that session's cookie.
 */
export async function mediaPage(chromium: ChromiumBrowser, client: Browser,
  options: { viewport?: { width: number; height: number } | null } = {}): Promise<Page> {
  await forwardPublicOrigin();
  const context = await chromium.newContext(options);
  // tsx keeps function names with an `__name` helper that page.evaluate callbacks do not carry.
  await context.addInitScript({ content: 'window.__name = (fn) => fn;' });
  await context.addCookies([...client.cookies].map(([name, value]) => ({ name, value, url: publicOrigin })));
  const page = await context.newPage();
  await page.goto(`${publicOrigin}/api/v1/health`);
  await page.addScriptTag({ path: sdkPath });
  return page;
}

export async function openRoom(page: Page, url: string, token: string): Promise<void> {
  await page.evaluate(async ({ url, token }) => {
    const w = window as MediaPage;
    const sdk = w.LivekitClient ?? w.LiveKitClient;
    if (!sdk) throw new Error('Pinned LiveKit browser SDK did not expose its UMD global');
    const room = new sdk.Room();
    const events: string[] = [];
    w.fluxEvents = events;
    const identity = (participant: unknown) => (participant as { identity?: string })?.identity ?? '?';
    room.on('participantConnected', (participant) => events.push(`joined:${identity(participant)}`))
      .on('participantDisconnected', (participant) => events.push(`left:${identity(participant)}`))
      .on('trackSubscribed', (_track, _publication, participant) => events.push(`track:${identity(participant)}`))
      .on('connectionStateChanged', (state) => events.push(`state:${String(state)}`));
    w.fluxRoom = room;
    await room.connect(url, token);
  }, { url, token });
  assert.equal(await page.evaluate(() => (window as MediaPage).fluxRoom?.state), 'connected');
}

export async function refreshedToken(page: Page, original: string): Promise<string> {
  await page.waitForFunction((first) => {
    const current = (window as MediaPage).fluxRoom?.engine.token;
    return typeof current === 'string' && current !== first;
  }, original, { timeout: 15_000 });
  const token = await page.evaluate(() => (window as MediaPage).fluxRoom?.engine.token);
  assert.ok(token && token !== original, 'the token was actually refreshed by the SFU');
  return token;
}

export function tokenClaims(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    exp: number; sub: string; metadata?: string; video: { room: string };
  };
}

export function roomName(token: string): string {
  const payload = tokenClaims(token);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'token is still valid when tested');
  assert.match(payload.video.room, /^live_[A-Za-z0-9_-]{32}$/);
  return payload.video.room;
}

/**
 * Starts a second client with `token` and waits for the gate's refusal of it: the LiveKit
 * client asks `…/validate` only after its WebSocket failed. Returns what was refused.
 */
export async function refusedAtGate(page: Page, url: string, token: string): Promise<string> {
  const refused = page.waitForResponse((response) => response.url().includes('/media/rtc') &&
    response.url().includes('/validate') && response.status() === 401, { timeout: 10_000 });
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
