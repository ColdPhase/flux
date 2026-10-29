import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { Conversation, MessageLinkPreviews, Project, Workspace } from '@flux/contracts';
import { buildApp } from '../../apps/server/src/app.js';
import { loadServerConfig } from '../../apps/server/src/config.js';
import { FETCHES_PER_MINUTE } from '../../apps/server/src/link-previews/service.js';
import { createSealed, lock, passphrase, unlock } from './support/encryption.js';
import { Browser } from './support/http.js';
import { addMember, expectStatus, grant, person, project, workspace, type Person } from './support/people.js';

// Link cards (#469, F-026 §6) through the real API container, which fetches pages only from the Compose `linkmock`
// (support/link-mock.ts) under the name public.test. Everything the attacker controls (the address in a message, its redirects)
// is judged by the production rules; the unit suite (link-fetch.test.ts) drives the same fetcher with real sockets.

const mock = process.env.FLUX_LINK_MOCK_URL ?? 'http://linkmock:8098';
const hitsOf = async (prefix = '') => (await (await fetch(`${mock}/__hits?prefix=${encodeURIComponent(prefix)}`)).json()) as { path: string; headers: Record<string, string | undefined> }[];
const reset = async () => { await fetch(`${mock}/__reset`); };
const site = (path: string) => `http://public.test${path}`;

// Each group acts as its own person in its own project: the rate limit (20 new fetches a minute) is per person.
let owner: Person; let partner: Person; let outsider: Person;
let ws: Workspace; let room: Project; let other: Project;
interface Scene { who: Person; project: Project }
async function scene(label: string): Promise<Scene> {
  const who = await person(`links-${label}`);
  return { who, project: await project(who, (await workspace(who, `Links ${label}`)).id, `Links ${label}`, 'workspace') };
}

async function say(who: Person, projectId: string, body: string): Promise<string> {
  const made = expectStatus(await who.browser.request('POST', `/api/v1/projects/${projectId}/conversations`, { body: { body, clientMessageId: randomUUID() } }), 201) as Conversation;
  return made.messages[0]!.id;
}
async function cardsOf(who: Person, projectId: string, messageId: string) {
  return expectStatus(await who.browser.request('GET', `/api/v1/projects/${projectId}/messages/${messageId}/link-previews`), 200) as MessageLinkPreviews;
}
let current: Scene;
const use = (label: string) => before(async () => { current = await scene(label); });
const cardsFor = async (body: string, at: Scene = current) => cardsOf(at.who, at.project.id, await say(at.who, at.project.id, body));

before(async () => {
  [owner, partner, outsider] = await Promise.all(['links-owner', 'links-partner', 'links-outsider'].map(person));
  ws = await workspace(owner, 'Harbour desk');
  await addMember(owner, ws.id, partner, 'member');
  await addMember(owner, ws.id, outsider, 'member');
  room = await project(owner, ws.id, 'Ferry notes', 'restricted');
  other = await project(owner, ws.id, 'Elsewhere', 'restricted');
  await grant(owner, room.id, partner, 'contributor');
});

describe('the card data', () => {
  use('data');
  test('a page gives its own title and description, as plain text of bounded length', async () => {
    await reset();
    const result = await cardsFor(`Winter timetable ${site('/article')} (see the board).`);
    assert.equal(result.status, 'ready');
    assert.equal(result.cards.length, 1);
    const [card] = result.cards;
    assert.deepEqual(Object.keys(card!).sort(), ['description', 'title', 'url']);
    assert.equal(card!.url, site('/article'));
    // og:title wins over <title>; entities are decoded once; tags in the description are dropped; the script's decoys are ignored.
    assert.equal(card!.title, 'Harbour & Co: the winter ferry timetable');
    assert.equal(card!.description, 'Sailings move to the winter timetable on 3 November. Crossings run twice a day, and the last boat leaves the island at 17:40 — check the harbour board before you set out. Bring a coat and a flask too.');
    for (const text of [card!.title, card!.description]) assert.ok(!/[<>]/.test(text!), text!);
  });

  test('the plain <title> and meta description are used when there is no Open Graph; a title alone is a card with no description', async () => {
    assert.deepEqual((await cardsFor(site('/plain'))).cards, [{ url: site('/plain'), title: 'Plain page', description: 'A plain description.' }]);
    assert.deepEqual((await cardsFor(site('/title-only'))).cards, [{ url: site('/title-only'), title: 'Only a title here', description: null }]);
  });

  test('long values are cut (200 and 300 characters)', async () => {
    const [card] = (await cardsFor(site('/long'))).cards;
    assert.equal([...card!.title!].length, 200);
    assert.equal([...card!.description!].length, 300);
    assert.ok(card!.title!.endsWith('…'));
  });

  test('a page with nothing to say, a 404, an image and JSON give no card (the reader keeps the address card)', async () => {
    const result = await cardsFor(`${site('/nothing')} ${site('/png')} ${site('/json')}`);
    assert.deepEqual(result, { status: 'ready', cards: [] });
    assert.deepEqual((await cardsFor(site('/not-found'))).cards, []);
  });

  test('only the first three distinct addresses of the stored message are asked for', async () => {
    await reset();
    const body = `${site('/page/1')} again ${site('/page/1')} ${site('/page/2')} ${site('/page/3')} ${site('/page/4')}`;
    const result = await cardsFor(body);
    assert.deepEqual(result.cards.map((card) => card.url), [site('/page/1'), site('/page/2'), site('/page/3')]);
    assert.equal((await hitsOf('/page/4')).length, 0);
  });

  test('a message without an address, and a plain-looking one, need no fetch', async () => {
    await reset();
    assert.deepEqual(await cardsFor('No link here, only words and an @owner mention.'), { status: 'ready', cards: [] });
    assert.deepEqual(await cardsFor('mailto:someone@example.org and ftp://public.test/file'), { status: 'ready', cards: [] });
    assert.equal((await hitsOf()).length, 0);
  });
});

describe('access follows the message', () => {
  test('members who can read the project get the cards; an outsider, another project and an unknown message answer 404', async () => {
    const id = await say(owner, room.id, site('/plain'));
    assert.equal((await cardsOf(partner, room.id, id)).cards.length, 1);
    // outsider is a workspace member without access to the restricted project.
    const response = await outsider.browser.request('GET', `/api/v1/projects/${room.id}/messages/${id}/link-previews`);
    assert.equal(response.status, 404, response.text);
    assert.equal((await owner.browser.request('GET', `/api/v1/projects/${other.id}/messages/${id}/link-previews`)).status, 404, 'a message under another project');
    assert.equal((await owner.browser.request('GET', `/api/v1/projects/${room.id}/messages/${randomUUID()}/link-previews`)).status, 404);
    assert.equal((await owner.browser.request('GET', `/api/v1/projects/${randomUUID()}/messages/${id}/link-previews`)).status, 404);
  });

  test('a caller cannot name an address: the route takes none, and a query string changes nothing', async () => {
    await reset();
    const id = await say(owner, room.id, 'nothing to fetch');
    const response = await owner.browser.request('GET', `/api/v1/projects/${room.id}/messages/${id}/link-previews?url=${encodeURIComponent(site('/secret'))}`);
    assert.deepEqual(response.json, { status: 'ready', cards: [] });
    assert.equal((await hitsOf()).length, 0);
  });

  test('a malformed id answers 400 INVALID_INPUT and echoes no query', async () => {
    const id = await say(owner, room.id, site('/plain'));
    for (const bad of ['not-a-uuid', encodeURIComponent("' OR 1=1 --"), encodeURIComponent('../x'), '123', `${id}x`]) {
      const asMessage = await owner.browser.request('GET', `/api/v1/projects/${room.id}/messages/${bad}/link-previews`);
      assert.equal(asMessage.status, 400, `${bad}: ${asMessage.text}`);
      assert.equal((asMessage.json as { code?: string }).code, 'INVALID_INPUT');
      const asProject = await owner.browser.request('GET', `/api/v1/projects/${bad}/messages/${id}/link-previews`);
      assert.equal(asProject.status, 400, `${bad}: ${asProject.text}`);
      for (const text of [asMessage.text, asProject.text]) assert.doesNotMatch(text, /select|from "|Failed query/i);
    }
  });

  test('without a session the route answers 401', async () => {
    const id = await say(owner, room.id, site('/plain'));
    assert.equal((await new Browser().request('GET', `/api/v1/projects/${room.id}/messages/${id}/link-previews`)).status, 401);
  });
});

describe('addresses the server must not fetch', () => {
  use('blocked');
  test('private, loopback, link-local, metadata, mapped, numeric and credentialed addresses, other ports and other schemes: no card, no request', async () => {
    await reset();
    const groups = [
      ['http://127.0.0.1/secret', 'http://localhost/secret', 'http://169.254.169.254/latest/meta-data/'],
      ['http://[::1]/secret', 'http://[::ffff:127.0.0.1]/secret', 'http://[::ffff:169.254.169.254]/'],
      ['http://2130706433/secret', 'http://0x7f.1/secret', 'http://0177.0.0.1/secret'],
      ['http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/'],
      [site(':8098/secret'), 'http://user:pw@public.test/secret', 'http://linkmock/secret'],
      ['http://public.local/secret', 'http://metadata.internal/', 'http://[fe80::1]/'],
    ];
    for (const urls of groups) assert.deepEqual(await cardsFor(urls.join(' ')), { status: 'ready', cards: [] }, urls.join(' '));
    assert.equal((await hitsOf()).length, 0, 'nothing reached the mock');
  });

  test('a redirect is judged like a new address: to a private name, loopback, metadata, another port, credentials or a non-http scheme', async () => {
    await reset();
    for (const path of ['/redirect-private', '/redirect-loopback', '/redirect-metadata', '/redirect-port', '/redirect-credentials', '/redirect-ftp', '/redirect-file', '/redirect-empty'])
      assert.deepEqual((await cardsFor(site(path))).cards, [], path);
    assert.equal((await hitsOf('/secret')).length, 0, 'no redirect target was requested');
  });

  test('redirects are followed up to three hops, and no further', async () => {
    assert.equal((await cardsFor(site('/redirect-ok'))).cards[0]?.title, 'Harbour & Co: the winter ferry timetable');
    assert.equal((await cardsFor(site('/hop/3'))).cards.length, 1, 'three redirects');
    assert.equal((await cardsFor(site('/hop/4'))).cards.length, 0, 'four redirects');
    assert.equal((await cardsFor(site('/loop'))).cards.length, 0);
  });
});

describe('what the request carries, and its bounds', () => {
  use('request');
  test('a fixed User-Agent and nothing of the reader: no cookie (even one the site sets), referer, credentials or language', async () => {
    await reset();
    await cardsFor(site('/cookie'));
    const hits = await hitsOf();
    assert.deepEqual(hits.map((hit) => hit.path), ['/cookie', '/echo']);
    for (const hit of hits) {
      assert.match(hit.headers['user-agent'] ?? '', /^FluxLinkPreview\/1 /);
      for (const name of ['cookie', 'referer', 'authorization', 'accept-language']) assert.equal(hit.headers[name], undefined, `${name} on ${hit.path}`);
      assert.equal(hit.headers['accept-encoding'], 'identity');
      assert.equal(hit.headers.host, 'public.test');
    }
  });

  test('only the start of a large page is read, and a slow page is given up on within the total limit', async () => {
    const [big] = (await cardsFor(site('/big'))).cards;
    assert.deepEqual([big?.title, big?.description], ['Big page start', 'Read from the first bytes.']);
    const started = Date.now();
    assert.deepEqual((await cardsFor(site('/slow'))).cards, []);
    const took = Date.now() - started;
    assert.ok(took < 4_500, `gave up after ${took} ms`);
  });
});

describe('cache and rate limit', () => {
  test('a page is fetched once for everyone who reads the message', async () => {
    await reset();
    const id = await say(owner, room.id, site('/page/cached'));
    assert.equal((await cardsOf(owner, room.id, id)).cards.length, 1);
    assert.equal((await cardsOf(partner, room.id, id)).cards.length, 1);
    assert.equal((await cardsOf(owner, room.id, id)).cards.length, 1);
    assert.equal((await hitsOf('/page/cached')).length, 1);
  });

  test('one person starts at most 20 fetches a minute; the rest answer busy and fetch nothing', async () => {
    const heavy = await person('links-heavy');
    const w = await workspace(heavy, 'Many links');
    const p = await project(heavy, w.id, 'Link pile', 'workspace');
    await reset();
    const answers: MessageLinkPreviews[] = [];
    for (let batch = 0; batch < 8; batch++) {
      const urls = [0, 1, 2].map((n) => site(`/page/rate-${batch * 3 + n}`));
      answers.push(await cardsOf(heavy, p.id, await say(heavy, p.id, urls.join(' '))));
    }
    assert.equal(answers.slice(0, 6).every((answer) => answer.status === 'ready' && answer.cards.length === 3), true);
    assert.equal(answers[6]!.status, 'busy', 'the 21st fetch of the minute');
    assert.equal(answers[6]!.cards.length, FETCHES_PER_MINUTE - 18);
    assert.equal((await hitsOf('/page/rate-')).length, FETCHES_PER_MINUTE);
    // Another person is not held back by it.
    assert.equal((await cardsOf(owner, room.id, await say(owner, room.id, site('/page/rate-other')))).status, 'ready');
  });
});

describe('where previews are never fetched', () => {
  use('sealed-control');
  test('an encrypted workspace never fetches (its links would leave the server in the clear), locked or unlocked', async () => {
    const ada = await person('links-sealed');
    const pw = passphrase();
    const sealed = (await createSealed(ada, 'Sealed desk', pw)).workspace;
    const key = () => ({ 'idempotency-key': randomUUID() });
    const made = expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${sealed.id}/projects`, { body: { name: 'Secret links', visibility: 'workspace' }, headers: key() }), 201) as Project;
    const conversation = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${made.id}/conversations`,
      { body: { body: site('/page/sealed-secret'), clientMessageId: randomUUID() }, headers: key() }), 201) as Conversation;
    const messageId = conversation.messages[0]!.id;
    await reset();
    const open = await ada.browser.request('GET', `/api/v1/projects/${made.id}/messages/${messageId}/link-previews`);
    assert.deepEqual(open.json, { status: 'sealed', cards: [] });
    expectStatus(await lock(ada.browser, sealed.id), 200);
    const locked = await ada.browser.request('GET', `/api/v1/projects/${made.id}/messages/${messageId}/link-previews`);
    assert.equal(locked.status, 423, locked.text);
    expectStatus(await unlock(ada.browser, sealed.id, { password: pw }), 200);
    assert.deepEqual((await ada.browser.request('GET', `/api/v1/projects/${made.id}/messages/${messageId}/link-previews`)).json, { status: 'sealed', cards: [] });
    assert.equal((await hitsOf()).length, 0, 'the sealed workspace\'s address never reached a site');
    // Negative control: an address in a plain workspace is fetched.
    assert.equal((await cardsFor(site('/page/sealed-control'))).cards.length, 1);
    assert.equal((await hitsOf('/page/sealed-control')).length, 1);
    assert.equal((await hitsOf('/page/sealed-secret')).length, 0);
  });

  test('off is the default: an install whose operator has not turned previews on fetches nothing', async () => {
    const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...process.env, FLUX_FIXTURE_TOKEN: process.env.FLUX_FIXTURE_TOKEN || 'fixture-link-previews', FLUX_TEST_FAILURE_INJECTION: 'true',
      FLUX_LINK_PREVIEWS: '', FLUX_TEST_LINK_PREVIEW_HOSTS: 'public.test=linkmock:8098', ...extra });
    const config = (extra: Record<string, string>) => loadServerConfig(env(extra), '/nonexistent/flux_background_key');
    assert.equal(config({}).linkPreviews.enabled, false);
    assert.equal(config({ FLUX_LINK_PREVIEWS: 'off' }).linkPreviews.enabled, false);
    assert.equal(config({ FLUX_LINK_PREVIEWS: 'on' }).linkPreviews.enabled, true);
    assert.throws(() => config({ FLUX_LINK_PREVIEWS: 'sometimes' }), /FLUX_LINK_PREVIEWS must be on or off/);
    assert.throws(() => config({ FLUX_TEST_FAILURE_INJECTION: 'false' }), /test deployments only/);
    const id = await say(owner, room.id, site('/page/off-default'));
    await reset();
    const off = await buildApp(config({}));
    try {
      const response = await off.inject({ method: 'GET', url: `/api/v1/projects/${room.id}/messages/${id}/link-previews`,
        headers: { cookie: owner.browser.cookieHeader(), origin: process.env.FLUX_PUBLIC_ORIGIN ?? '' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { status: 'off', cards: [] });
    } finally { await off.close(); }
    assert.equal((await hitsOf()).length, 0);
  });
});
