import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeCookies } from '../../apps/server/src/stream/routes.js';

// #1313: the log line of a refused stream upgrade says whether the session cookie came, by name only.
test('a refused upgrade is logged with the names of the cookies it carried and whether the session cookie was among them, never a value', () => {
  const none = upgradeCookies(undefined, 'http://127.0.0.1:18591');
  assert.deepEqual(none, { cookieHeader: false, cookieNames: [], sessionCookie: false });
  const other = upgradeCookies('theme=dark; flux.device=abc', 'http://127.0.0.1:18591');
  assert.deepEqual(other, { cookieHeader: true, cookieNames: ['theme', 'flux.device'], sessionCookie: false });
  const session = upgradeCookies('flux.session_token=SECRETVALUE.SIGNATURE; theme=dark', 'http://127.0.0.1:18591');
  assert.deepEqual(session, { cookieHeader: true, cookieNames: ['flux.session_token', 'theme'], sessionCookie: true });
  assert.ok(!JSON.stringify(session).includes('SECRETVALUE'), 'no value is ever in the log');
  // Over https the cookie is `__Secure-` prefixed: the plain name is not the session cookie there.
  assert.equal(upgradeCookies('__Secure-flux.session_token=v.s', 'https://flux.example').sessionCookie, true);
  assert.equal(upgradeCookies('flux.session_token=v.s', 'https://flux.example').sessionCookie, false);
  assert.equal(upgradeCookies('flux.session_token=', 'http://127.0.0.1:18591').sessionCookie, false, 'an empty cookie is no cookie');
  const nameless = upgradeCookies('NAMELESSSECRET; theme=dark', 'http://127.0.0.1:18591');
  assert.deepEqual(nameless.cookieNames, ['(no name)', 'theme'], 'a cookie with no name is counted, its value never written');
  assert.ok(!JSON.stringify(nameless).includes('NAMELESSSECRET'));
  assert.equal(upgradeCookies(Array.from({ length: 30 }, (_, i) => `c${i}=1`).join('; '), 'http://x').cookieNames.length, 12, 'the list is bounded');
});
