import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_SIGN_OUT_PATH, REVOKE_OTHER_SESSIONS_PATH, SESSIONS_PATH } from '@flux/contracts';
import { pool } from './support/db.js';
import { Browser, publicOrigin, signIn } from './support/http.js';
import { person, password, secondSession, type Person } from './support/people.js';
import { StreamClient, upgradeStatus } from './support/stream.js';

// #1178: a session cookie Better Auth accepted is read again on later requests as one statement on its session row, in each API
// process. Revocation must not wait for anything: a sign-out, a revoked session, an expiry or a deleted account is refused on the very
// next request, in the `api` container and in `api2` alike, after both have read the session several times.
const api2Url = process.env.FLUX_API2_URL ?? 'http://api2:8080';

/** A copy of the browser's cookies, against the first API process (`base` left out) or the second. */
function copy(browser: Browser, base?: string): Browser {
  const twin = base ? new Browser(base, publicOrigin) : new Browser();
  for (const [name, value] of browser.cookies) twin.cookies.set(name, value);
  return twin;
}
const onApi2 = (browser: Browser) => copy(browser, api2Url);

async function warm(...browsers: Browser[]) {
  for (const browser of browsers) for (let i = 0; i < 3; i++) assert.equal((await browser.request('GET', '/api/v1/me')).status, 200);
}

async function refusedEverywhere(browsers: Browser[], why: string) {
  for (const [i, browser] of browsers.entries()) assert.equal((await browser.request('GET', '/api/v1/me')).status, 401, `${why}: refused at once on ${i ? 'api2' : 'api'}`);
}

async function session(owner: Person) {
  const second = await secondSession(owner);
  const browsers = [copy(second.browser), onApi2(second.browser)];
  await warm(...browsers);
  return { ...second, browsers };
}

test('a sign-out, a revoked session, an expiry, the maximum age and a deleted account are refused on the very next request on both API processes', async () => {
  const owner = await person('session-fast-path');

  const signedOut = await session(owner);
  assert.equal((await signedOut.browser.request('POST', AUTH_SIGN_OUT_PATH, { body: {} })).status, 200);
  // The browser dropped its cookie; the same cookie sent again (a copy of it, read on both processes before) is refused too.
  await refusedEverywhere(signedOut.browsers, 'signed out on api');

  // Ended from another browser of the person, on the other API process: one session, then "Sign out all other devices".
  const revoked = await session(owner);
  assert.equal((await onApi2(owner.browser).request('DELETE', `${SESSIONS_PATH}/${revoked.sessionId}`)).status, 204);
  await refusedEverywhere(revoked.browsers, 'revoked from another browser');
  const others = [await session(owner), await session(owner)];
  assert.equal((await onApi2(owner.browser).request('POST', REVOKE_OTHER_SESSIONS_PATH, { body: {} })).status, 200);
  for (const other of others) await refusedEverywhere(other.browsers, 'signed out everywhere else');

  const removed = await session(owner);
  await pool.query('DELETE FROM auth_sessions WHERE id = $1', [removed.sessionId]);
  await refusedEverywhere(removed.browsers, 'its row deleted');

  // Signed in longer ago than the maximum (30 days in the check stack), used a moment ago: the fast path checks the absolute limit too (#993).
  const old = await session(owner);
  await pool.query("UPDATE auth_sessions SET created_at = clock_timestamp() - interval '31 days' WHERE id = $1", [old.sessionId]);
  await refusedEverywhere(old.browsers, 'past the maximum age');
  assert.equal((await pool.query('SELECT 1 FROM auth_sessions WHERE id = $1', [old.sessionId])).rowCount, 0, 'and its row goes');

  const expired = await session(owner);
  await pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [expired.sessionId]);
  await refusedEverywhere(expired.browsers, 'expired');

  // Every session of the person goes with the account; the person's first session was read on api many times.
  const gone = await person('session-fast-path-deleted');
  const goneBrowsers = [gone.browser, onApi2(gone.browser)];
  await warm(...goneBrowsers);
  await pool.query('DELETE FROM auth_users WHERE id = $1', [gone.id]);
  await refusedEverywhere(goneBrowsers, 'account deleted');

  // Another session of the same person is untouched by all of this.
  assert.equal((await owner.browser.request('GET', '/api/v1/me')).status, 200);
});

test('a cookie whose signature was altered is refused even while the real cookie is read on the fast path', async () => {
  const owner = await person('session-fast-path-forged');
  await warm(owner.browser);
  const forged = new Browser();
  for (const [name, value] of owner.browser.cookies) {
    const decoded = decodeURIComponent(value);
    const dot = decoded.lastIndexOf('.');
    // Same token, another signature.
    forged.cookies.set(name, dot > 0 && name.endsWith('session_token') ? encodeURIComponent(`${decoded.slice(0, dot)}.${'A'.repeat(decoded.length - dot - 1)}`) : value);
  }
  assert.equal((await forged.request('GET', '/api/v1/me')).status, 401);
  assert.equal((await owner.browser.request('GET', '/api/v1/me')).status, 200);
});

test('the fast path reads the person afresh and hands a session due for renewal back to Better Auth, which renews it', async () => {
  const owner = await person('session-fast-path-renew');
  const browsers = [owner.browser, onApi2(owner.browser)];
  await warm(...browsers);
  await pool.query('UPDATE auth_users SET name = $1 WHERE id = $2', ['Renamed Person', owner.id]);
  for (const browser of browsers) assert.equal(((await browser.request('GET', '/api/v1/me')).json as { user: { name: string } }).user.name, 'Renamed Person');
  // Due for renewal: an expiry closer than the idle limit minus updateAge (a minute left of a far longer idle limit).
  const { rows: [{ id }] } = await pool.query<{ id: string }>('SELECT s.id FROM auth_sessions s WHERE s.user_id = $1', [owner.id]);
  await pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1", [id]);
  for (const browser of browsers) assert.equal((await browser.request('GET', '/api/v1/me')).status, 200);
  const { rows: [after] } = await pool.query<{ left: number }>('SELECT extract(epoch FROM expires_at - clock_timestamp())::int AS left FROM auth_sessions WHERE id = $1', [id]);
  assert.ok(after!.left > 120, `Better Auth renewed the session (it has ${after!.left} s left)`);
});

// #1313: a WebKit page's stream got 401 on every reconnect while the same person's HTTP reads were 200. The upgrade reads the session with the
// same function as every HTTP request (`resolveSession` → `read`), so the two must agree in every state of the session read: the first read of a
// cookie on a process (Better Auth), a cookie the fast path knows, a session due for renewal, one that is expired or revoked, and on both API
// processes; and an open stream, which reads the session again on every heartbeat (1 s in this stack), must survive its session's renewal.
test('the live stream reads the session exactly as an HTTP request does, on both API processes, and an open stream survives its session being renewed', async () => {
  const owner = await person('session-fast-path-stream');
  const bases = [undefined, api2Url] as const;
  const twins = (browser: Browser) => [copy(browser), onApi2(browser)];
  const statuses = (browsers: Browser[]) => Promise.all(browsers.map(async (browser, i) => ({
    http: (await browser.request('GET', '/api/v1/me')).status, stream: await upgradeStatus(browser, { base: bases[i] }),
  })));
  const same = (rows: { http: number; stream: number }[], http: number, stream: number, why: string) => assert.deepEqual(rows, [{ http, stream }, { http, stream }], why);

  // A session nobody has read on either process: the upgrade is the first read, then HTTP; and the other way round.
  const first = (await signIn(owner.email, password)).browser;
  const firstTwins = twins(first);
  const coldStream = await Promise.all(firstTwins.map((browser, i) => upgradeStatus(browser, { base: bases[i] })));
  assert.deepEqual(coldStream, [101, 101], 'the first read of a cookie on each process is the upgrade, and it is accepted');
  same(await statuses(firstTwins), 200, 101, 'then both read it from the fast path');
  const second = (await signIn(owner.email, password)).browser;
  const secondTwins = twins(second);
  for (const browser of secondTwins) assert.equal((await browser.request('GET', '/api/v1/me')).status, 200);
  assert.deepEqual(await Promise.all(secondTwins.map((browser, i) => upgradeStatus(browser, { base: bases[i] }))), [101, 101], 'the first read was HTTP, the upgrade follows');

  // Due for renewal: an open stream (each heartbeat reads the session again) stays open, and so does a new one.
  const third = await secondSession(owner);
  const thirdTwins = twins(third.browser);
  await warm(...thirdTwins);
  const open = await Promise.all(thirdTwins.map((browser, i) => StreamClient.connect(browser, { base: bases[i] })));
  await Promise.all(open.map((client) => client.ready()));
  const due = () => pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1", [third.sessionId]);
  const secondsLeft = async () => (await pool.query<{ left: number }>('SELECT extract(epoch FROM expires_at - clock_timestamp())::int AS left FROM auth_sessions WHERE id = $1', [third.sessionId])).rows[0]!.left;
  // The upgrade is the read that renews it, on one process and then on the other.
  for (const [i, browser] of thirdTwins.entries()) {
    await due();
    assert.equal(await upgradeStatus(browser, { base: bases[i] }), 101, `a session due for renewal is accepted by the upgrade on ${i ? 'api2' : 'api'}`);
    const left = await secondsLeft();
    assert.ok(left > 120, `and the upgrade renewed it (${left} s left)`);
  }
  await due();
  same(await statuses(thirdTwins), 200, 101, 'a session due for renewal is accepted by HTTP and by the upgrade, on both');
  // The stream opened before the renewal reads the session on its heartbeats and is still open after several of them.
  const pings = open.map((client) => client.pings);
  await Promise.all(open.map((client, i) => client.until(() => client.pings >= pings[i]! + 3, 8000, 'three heartbeats after the renewal')));
  for (const client of open) assert.equal(client.closeCode, null, 'the open stream was not closed by its session being renewed');
  for (const client of open) await client.close();

  // Ended: HTTP and the upgrade are both refused on the very next read, and an open stream is closed with 4401.
  const fourth = await secondSession(owner);
  const fourthTwins = twins(fourth.browser);
  await warm(...fourthTwins);
  const watching = await Promise.all(fourthTwins.map((browser, i) => StreamClient.connect(browser, { base: bases[i] })));
  await Promise.all(watching.map((client) => client.ready()));
  await pool.query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [fourth.sessionId]);
  same(await statuses(fourthTwins), 401, 401, 'an expired session is refused by both');
  for (const client of watching) assert.equal((await client.closed).code, 4401, 'and an open stream is closed as unauthenticated');
  const revoked = await secondSession(owner);
  const revokedTwins = twins(revoked.browser);
  await warm(...revokedTwins);
  assert.equal((await onApi2(owner.browser).request('DELETE', `${SESSIONS_PATH}/${revoked.sessionId}`)).status, 204);
  same(await statuses(revokedTwins), 401, 401, 'a revoked session is refused by both');
  // No cookie at all is the same refusal, and it is what a browser that did not send its cookie gets.
  assert.equal(await upgradeStatus(null), 401);
  assert.equal(await upgradeStatus(new Browser()), 401);
});
