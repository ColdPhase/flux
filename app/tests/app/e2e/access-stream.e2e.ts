import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { password } from '../support/people.js';

/**
 * Login, sharing, denied access and stream revocation in real Chromium sessions against the
 * running Compose services (issue #29, AC-4). The web app on main is still the placeholder
 * shell, so each page signs up and calls the API with same-origin `fetch` and a page
 * `WebSocket`: the browser holds the session cookie, sends Origin, and runs the socket.
 *
 * A small reverse proxy inside this container listens on the host:port of
 * FLUX_PUBLIC_ORIGIN and forwards HTTP and WebSocket upgrades to the API container, so the
 * page origin is exactly the public origin that the API accepts for cookie sessions.
 * Set FLUX_E2E_EVIDENCE_DIR to keep screenshots and a JSON transcript of what was observed.
 */
const upstream = new URL(process.env.FLUX_API_URL ?? 'http://api:8080');
const publicOrigin = new URL(process.env.FLUX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:18089');
const evidenceDir = process.env.FLUX_E2E_EVIDENCE_DIR;
const upstreamPort = Number(upstream.port || 80);

const proxy = http.createServer((request, response) => {
  const forward = http.request({ host: upstream.hostname, port: upstreamPort, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  forward.on('error', () => response.destroy());
  request.pipe(forward);
});
proxy.on('upgrade', (request, socket, head) => {
  const target = net.connect(upstreamPort, upstream.hostname, () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  const end = () => { target.destroy(); socket.destroy(); };
  target.on('error', end);
  socket.on('error', end);
});

interface Call { status: number; json: unknown }
interface Transcript { step: string; who: string; observed: unknown }
const transcript: Transcript[] = [];

let browser: Browser;
const contexts: BrowserContext[] = [];

class Person {
  id = '';
  readonly email: string;
  constructor(readonly label: string, readonly page: Page) {
    this.email = `e2e-${label.toLowerCase()}-${randomUUID()}@example.test`;
  }

  /** Same-origin fetch from the page: the browser attaches the cookie and Origin itself. */
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Call> {
    return this.page.evaluate(async ({ method, path, body, headers }) => {
      const response = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json };
    }, { method, path, body, headers });
  }

  async expect(method: string, path: string, status: number, body?: unknown, headers?: Record<string, string>) {
    const result = await this.call(method, path, body, headers);
    assert.equal(result.status, status, `${this.label} ${method} ${path}: ${JSON.stringify(result.json)}`);
    return result.json as Record<string, unknown>;
  }

  async signUp() {
    await this.page.goto(`${publicOrigin.origin}/`);
    await this.expect('POST', '/api/auth/sign-up/email', 200, { email: this.email, password, name: this.label });
    const me = await this.expect('GET', '/api/v1/me', 200) as { user: { id: string } };
    this.id = me.user.id;
    await this.note('signed up and signed in in this browser', { user: this.id });
  }

  /** Records a step in the transcript and on the page, so screenshots show what the page observed. */
  async note(step: string, observed: unknown) {
    transcript.push({ step, who: this.label, observed });
    await this.page.evaluate(({ label, step, observed }) => {
      let log = document.getElementById('e2e-log');
      if (!log) {
        document.body.insertAdjacentHTML('beforeend', `<section style="font:13px/1.45 ui-monospace,monospace;margin:16px;max-width:760px"><h2 style="font:600 15px system-ui">${label}'s browser session</h2><ol id="e2e-log"></ol></section>`);
        log = document.getElementById('e2e-log')!;
      }
      const item = document.createElement('li');
      item.textContent = `${step} — ${JSON.stringify(observed)}`;
      log.append(item);
    }, { label: this.label, step, observed });
  }

  async screenshot(name: string) {
    if (evidenceDir) await this.page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  }

  /** Opens a WebSocket from the page and records every frame in `window.__frames`. */
  async openStream() {
    await this.page.evaluate(() => new Promise<void>((resolve, reject) => {
      const w = window as unknown as { __frames: { type: string; kind?: string; objectId?: string }[]; __socket: WebSocket };
      w.__frames = [];
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/v1/stream`);
      w.__socket = socket;
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data));
        w.__frames.push(frame);
        if (frame.type === 'ready') resolve();
      };
      socket.onerror = () => reject(new Error('stream failed'));
    }));
  }

  frames() {
    return this.page.evaluate(() => (window as unknown as { __frames: { type: string; kind?: string; objectId?: string }[] }).__frames);
  }

  async waitForFrame(objectId: string, kind: string) {
    await this.page.waitForFunction(({ objectId, kind }) => (window as unknown as { __frames: { kind?: string; objectId?: string }[] }).__frames
      .some((frame) => frame.objectId === objectId && frame.kind === kind), { objectId, kind }, { timeout: 15_000 });
  }

  socketState() {
    return this.page.evaluate(() => (window as unknown as { __socket: WebSocket }).__socket.readyState);
  }
}

async function newPerson(label: string) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  contexts.push(context);
  return new Person(label, await context.newPage());
}

before(async () => {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await new Promise<void>((resolve) => proxy.listen(Number(publicOrigin.port || 80), publicOrigin.hostname, resolve));
  browser = await chromium.launch();
});

after(async () => {
  if (evidenceDir) writeFileSync(join(evidenceDir, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
});

describe('access and stream in Chromium against the running services', () => {
  test('share to a granted member, deny a non-member, revoke and stop live events', async () => {
    const alice = await newPerson('Alice');
    const bob = await newPerson('Bob');
    const carol = await newPerson('Carol');
    for (const someone of [alice, bob, carol]) await someone.signUp();

    const space = await alice.expect('POST', '/api/v1/workspaces', 201, { name: 'Browser launch' }) as { id: string };
    await alice.expect('POST', `/api/v1/workspaces/${space.id}/members`, 201, { email: bob.email, role: 'member' });
    const room = await alice.expect('POST', `/api/v1/workspaces/${space.id}/projects`, 201, { name: 'Launch room', visibility: 'restricted' }) as { id: string };
    const grant = await alice.expect('POST', `/api/v1/projects/${room.id}/grants`, 201, { principal: { kind: 'human', id: bob.id }, role: 'viewer' }) as { id: string };
    await alice.note('created workspace, restricted project and viewer grant for Bob', { workspace: space.id, project: room.id, grant: grant.id });

    await bob.openStream();
    await bob.note('opened WebSocket /api/v1/stream in the page', { readyState: await bob.socketState() });

    const created = await alice.expect('POST', `/api/v1/workspaces/${space.id}/drafts`, 201, { title: 'Launch checklist', body: 'Private until shared', projectId: room.id }) as { id: string; version: number };
    const privateRead = await bob.call('GET', `/api/v1/drafts/${created.id}`);
    assert.equal(privateRead.status, 404, 'a private draft is invisible to a granted member');
    await bob.note('GET private draft before sharing', { status: privateRead.status });

    const shared = await alice.expect('POST', `/api/v1/drafts/${created.id}/share`, 200, { scope: 'project' }, { 'if-match': `"${created.version}"` }) as { id: string; version: number };
    await alice.note('shared the draft to the project', { draft: shared.id, version: shared.version });
    await bob.waitForFrame(created.id, 'draft.shared.v1');
    const bobRead = await bob.expect('GET', `/api/v1/drafts/${created.id}`, 200) as { title: string };
    assert.equal(bobRead.title, 'Launch checklist');
    await bob.note('stream delivered draft.shared.v1; GET draft', { status: 200, title: bobRead.title });
    await bob.screenshot('01-bob-granted-sees-shared-draft');

    const carolRead = await carol.call('GET', `/api/v1/drafts/${created.id}`);
    assert.equal(carolRead.status, 404, 'a non-member gets 404, not 403');
    const carolProject = await carol.call('GET', `/api/v1/projects/${room.id}`);
    assert.equal(carolProject.status, 404);
    await carol.note('GET the shared draft and its project as a non-member', { draft: carolRead.status, project: carolProject.status });
    await carol.screenshot('02-carol-non-member-404');

    await alice.expect('DELETE', `/api/v1/projects/${room.id}/grants/${grant.id}`, 204);
    await alice.note('revoked Bob\'s grant', { grant: grant.id });
    const updated = await alice.expect('PATCH', `/api/v1/drafts/${created.id}`, 200, { body: 'Edited after revocation' }, { 'if-match': `"${shared.version}"` }) as { version: number };
    // A visible sentinel afterwards proves the socket is still delivering, so the missing
    // update event is a denial, not a stalled stream.
    const sentinel = await alice.expect('POST', `/api/v1/workspaces/${space.id}/drafts`, 201, { title: 'All hands' }) as { id: string; version: number };
    await alice.expect('POST', `/api/v1/drafts/${sentinel.id}/share`, 200, { scope: 'workspace' }, { 'if-match': `"${sentinel.version}"` });
    await bob.waitForFrame(sentinel.id, 'draft.shared.v1');
    const frames = await bob.frames();
    const draftFrames = frames.filter((frame) => frame.objectId === created.id).map((frame) => frame.kind);
    const afterRevoke = draftFrames.slice(draftFrames.indexOf('draft.shared.v1') + 1);
    assert.deepEqual(afterRevoke, [], 'the edit after revocation never reached Bob');
    assert.equal(draftFrames.includes('draft.updated.v1'), false);
    const revokedRead = await bob.call('GET', `/api/v1/drafts/${created.id}`);
    assert.equal(revokedRead.status, 404, 'revoked access is denied');
    await bob.note('after revocation: stream frames for the draft, sentinel delivery, GET draft', {
      draftFrames, framesAfterRevocation: afterRevoke, sentinelDelivered: true, updatedVersion: updated.version, status: revokedRead.status, readyState: await bob.socketState(),
    });
    await bob.screenshot('03-bob-after-revocation');
  });
});
