import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from './support/db.js';
import { Browser, publicOrigin, register, signIn, uniqueEmail, waitForMail } from './support/http.js';
import { password } from './support/people.js';

// "Sign out all other devices" racing a password reset, and racing itself (#1067, from the review of #1044), through the running API containers.
// Whatever the order the requests take, no cookie that a sign-out answer gave out counts after the reset, and a burst from one browser leaves
// at most one cookie that counts.
if (!publicOrigin) throw new Error('FLUX_PUBLIC_ORIGIN is required');

const NEW_PASSWORD = 'the harbour lights at dawn';
const deviceCookieOf = (browser: Browser) => [...browser.cookies].find(([name]) => name.endsWith('flux.device'))!;
const givenBy = (setCookies: string[]) => setCookies.map((cookie) => /flux\.device=([^;]+)/.exec(cookie)?.[1]).filter((value): value is string => !!value);

/** The account waits (a stranger's six wrong passwords): a browser whose cookie counts has a wait of its own (401), one whose cookie does not meets the account's (429). */
async function makeAccountWait(email: string, label: string) {
  const stranger = new Browser();
  for (let attempt = 1; attempt <= 6; attempt++) await stranger.request('POST', '/api/auth/sign-in/email', { body: { email, password: `${label} stranger ${attempt}` } });
}
async function counts(name: string, value: string, email: string) {
  const probe = new Browser();
  probe.cookies.set(name, value);
  return (await probe.request('POST', '/api/auth/sign-in/email', { body: { email, password: 'a wrong guess from a copy' } })).status === 401;
}

test('a sign-out that races a reset leaves no cookie that counts after it, and the browser that reset keeps one that does', async () => {
  for (let round = 1; round <= 3; round++) {
    const email = uniqueEmail(`race-reset-${round}`);
    const { browser: owner } = await register(email, password);
    assert.equal((await owner.request('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: `${publicOrigin}/reset-password` } })).status, 200);
    const token = (await waitForMail(email)).match(/reset-password\/([^?\s]+)/)?.[1];
    assert.ok(token);
    // Someone who took the whole cookie jar (session and device cookie) keeps signing the others out, from several requests at once, with the
    // answers' cookies going back in, while the owner finishes the reset.
    const thief = new Browser();
    for (const [name, value] of owner.cookies) thief.cookies.set(name, value);
    const [deviceName] = deviceCookieOf(owner);
    const given = new Set<string>();
    let stop = false;
    const loop = async () => {
      while (!stop) {
        const out = await thief.request('POST', '/api/v1/sessions/revoke-others');
        if (out.status !== 200) return;
        for (const value of givenBy(out.setCookies)) given.add(value);
      }
    };
    const loops = Array.from({ length: 6 }, loop);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await owner.request('POST', '/api/auth/reset-password', { body: { token, newPassword: NEW_PASSWORD } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop = true;
    await Promise.all(loops);

    await makeAccountWait(email, `round ${round}`);
    assert.equal((await signIn(email, NEW_PASSWORD)).response.status, 429, 'the account waits for a browser nobody knows');
    for (const value of [...given].slice(-12)) assert.equal(await counts(deviceName, value, email), false, 'a cookie a sign-out answered with counts after the reset');
    const ownerOwn = new Browser();
    ownerOwn.cookies.set(deviceName, deviceCookieOf(owner)[1]);
    assert.equal((await ownerOwn.request('POST', '/api/auth/sign-in/email', { body: { email, password: NEW_PASSWORD } })).status, 200, 'the browser that reset keeps a cookie that counts');
  }
});

test('several sign-outs at once from one browser: no more cookies are given than raises were made, and at most one counts', async () => {
  for (let round = 1; round <= 4; round++) {
    const email = uniqueEmail(`race-burst-${round}`);
    const { browser: owner } = await register(email, password);
    const generation = async () => Number((await pool.query('SELECT device_generation AS g FROM auth_users WHERE email = $1', [email])).rows[0].g);
    const [deviceName] = deviceCookieOf(owner);
    // Six requests at once with the same cookies, as two tabs and a retry would send them.
    const answers = await Promise.all(Array.from({ length: 6 }, async () => {
      const tab = new Browser();
      for (const [name, value] of owner.cookies) tab.cookies.set(name, value);
      return tab.request('POST', '/api/v1/sessions/revoke-others');
    }));
    assert.ok(answers.every((answer) => answer.status === 200));
    const given = new Set(answers.flatMap((answer) => givenBy(answer.setCookies)));
    const made = await generation();
    assert.ok(made >= 1, 'the sign-outs raised the generation');
    assert.ok(given.size <= made, `${given.size} cookies for ${made} raises`);
    await makeAccountWait(email, `burst ${round}`);
    let counting = 0;
    for (const value of given) if (await counts(deviceName, value, email)) counting += 1;
    assert.ok(counting <= 1, `${counting} of the cookies count`);
  }
});
