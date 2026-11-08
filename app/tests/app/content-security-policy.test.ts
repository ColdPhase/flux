import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { documentPolicy, inlineHandlers, inlineScriptHashes, socketOrigins, WORKER_POLICY } from '../../apps/server/src/http/content-security-policy.js';
import { apiUrl, publicOrigin } from './support/http.js';

// The Content-Security-Policy of Flux's pages (#979): what it says, that each page's inline scripts are exactly the ones it hashes, and
// that the real server sends it on the app, a deep link, the offline page and the service worker. Browsers enforcing it, in Chromium
// and WebKit, are covered by tests/ui/test_csp.py and the violation list scripts/check_ui.sh reads.

const sha = (text: string) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
const directives = (policy: string) => new Map(policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
  const [name, ...values] = part.split(/\s+/);
  return [name!, values] as const;
}));
const fixtureBearer = () => ({ authorization: `Bearer ${process.env.FLUX_FIXTURE_TOKEN ?? ''}` });
// The API under test is a test deployment (the report list exists: 401 without the bearer) or not (404).
const testDeployment = (await fetch(new URL('/api/v1/test/csp-reports', apiUrl))).status === 401;

async function page(path: string, headers: Record<string, string> = { accept: 'text/html' }) {
  const response = await fetch(new URL(path, apiUrl), { headers });
  return { response, text: await response.text() };
}

describe('the policy a page gets', () => {
  test('it is strict by default and opens only what Flux uses', () => {
    const policy = documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: ['sha256-AAA='] });
    assert.equal(policy, [
      "default-src 'self'",
      "script-src 'self' 'sha256-AAA='",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "connect-src 'self' wss://flux.example.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    const parsed = directives(policy);
    assert.deepEqual(parsed.get('script-src'), ["'self'", "'sha256-AAA='"], "scripts: no 'unsafe-inline', no 'unsafe-eval', no wildcard, no https:");
    for (const [name, values] of parsed) {
      assert.ok(!values.includes('*') && !values.includes('http:') && !values.includes('https:'), `${name} names no wildcard or scheme`);
      if (name !== 'style-src') assert.ok(!values.includes("'unsafe-inline'"), `${name} allows no inline code`);
      assert.ok(!values.includes("'unsafe-eval'"), `${name} allows no eval`);
    }
  });

  test('the sockets are written out for the page\'s own origin, https as wss and loopback http as ws', () => {
    assert.deepEqual(socketOrigins('https://flux.example.com'), ['wss://flux.example.com']);
    assert.deepEqual(socketOrigins('http://127.0.0.1:8080'), ['ws://127.0.0.1:8080']);
    assert.match(documentPolicy({ publicOrigin: 'http://127.0.0.1:8080', scriptHashes: [] }), /connect-src 'self' ws:\/\/127\.0\.0\.1:8080/);
  });

  test('a test deployment\'s enforced policy adds only eval, for the test driver; the policy that ships is its report-only copy', () => {
    const shipped = documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: ['sha256-AAA='], reportUri: '/api/v1/test/csp-reports' });
    const enforced = documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: ['sha256-AAA='], allowEval: true });
    assert.equal(enforced.replace(" 'unsafe-eval'", ''), documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: ['sha256-AAA='] }));
    assert.ok(!shipped.includes('unsafe-eval'));
    assert.match(enforced, /script-src 'self' 'sha256-AAA=' 'unsafe-eval';/);
  });

  test('a test deployment adds the report address; the policy of an install has none', () => {
    assert.match(documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: [], reportUri: '/api/v1/test/csp-reports' }), /; report-uri \/api\/v1\/test\/csp-reports$/);
    assert.doesNotMatch(documentPolicy({ publicOrigin: 'https://flux.example.com', scriptHashes: [] }), /report-uri/);
  });

  test('the service worker may fetch its own files and show its own notification icon, and nothing else', () => {
    assert.deepEqual([...directives(WORKER_POLICY)], [['default-src', ["'none'"]], ['script-src', ["'self'"]], ['connect-src', ["'self'"]], ['img-src', ["'self'"]]]);
  });
});

describe('inline scripts', () => {
  test('each script that runs is hashed by its exact text; external scripts and data blocks are not', () => {
    const run = 'try { document.documentElement.dataset.theme = "dark"; } catch (e) {}';
    const html = `<head><script>${run}</script><script src="/a.js"></script><script type="application/json">{"a":1}</script>`
      + `<script type="module">import "/m.js";</script><script>   </script><script>${run}</script></head>`;
    assert.deepEqual(inlineScriptHashes(html), [sha(run), sha('import "/m.js";')]);
  });

  test('an inline event handler is found, whatever the case', () => {
    assert.deepEqual(inlineHandlers('<button type="button" onclick="x()">a</button><a href="#" OnMouseOver=\'y\'>b</a><p>onclick=x</p>'), ['onclick', 'onmouseover']);
    assert.deepEqual(inlineHandlers('<button id="retry">a</button><input value="a on b = c">'), []);
  });
});

describe('what the server sends', () => {
  const pages: Array<[string, string, Record<string, string>?]> = [
    ['the app', '/'],
    ['a deep link into the app', '/projects/some-project'],
    ['the offline page', '/offline.html', { accept: '*/*' }],
  ];
  for (const [label, path, headers] of pages) {
    test(`${label} carries the policy, and every inline script on it is hashed and no handler is inline`, async () => {
      const { response, text } = await page(path, headers);
      assert.equal(response.status, 200);
      const policy = response.headers.get('content-security-policy') ?? '';
      // The policy that ships: an install's enforced one, a test deployment's report-only copy (its enforced one adds eval for the test driver).
      const shipped = testDeployment ? (response.headers.get('content-security-policy-report-only') ?? '') : policy;
      if (testDeployment) assert.equal(policy.replace(" 'unsafe-eval'", ''), shipped.replace(/; report-uri \S+$/, ''), 'the enforced policy is the shipped one plus eval');
      else assert.equal(response.headers.get('content-security-policy-report-only'), null, 'an install sends no report-only policy');
      const script = directives(shipped).get('script-src') ?? [];
      assert.ok(script.includes("'self'") && !script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"), shipped);
      const hashes = inlineScriptHashes(text);
      assert.ok(hashes.length > 0, 'the page has an inline script to hash');
      assert.deepEqual(script.filter((value) => value.startsWith("'sha256-")), hashes.map((hash) => `'${hash}'`), 'the policy hashes exactly the page\'s inline scripts');
      assert.deepEqual(inlineHandlers(text), [], 'no inline event handler can run under this policy');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      for (const name of ['default-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors', 'connect-src']) assert.ok(directives(shipped).has(name), name);
      assert.ok((directives(shipped).get('connect-src') ?? []).some((value) => /^wss?:\/\//.test(value)), 'the sockets are named');
      assert.equal(directives(shipped).has('report-uri'), testDeployment, 'only a test deployment reports');
    });
  }

  test('the page names the origin its sockets use', async () => {
    const response = (await page('/')).response;
    const policy = response.headers.get('content-security-policy-report-only') ?? response.headers.get('content-security-policy') ?? '';
    if (!publicOrigin) return;
    const host = new URL(publicOrigin).host;
    assert.ok((directives(policy).get('connect-src') ?? []).includes(`${publicOrigin.startsWith('https:') ? 'wss' : 'ws'}://${host}`), policy);
  });

  test('a compressed copy of the app gets the same policy', async () => {
    const plain = (await page('/')).response.headers;
    for (const encoding of ['br', 'gzip']) {
      const { response } = await page('/', { accept: 'text/html', 'accept-encoding': encoding });
      assert.equal(response.headers.get('content-security-policy'), plain.get('content-security-policy'), encoding);
      assert.equal(response.headers.get('content-security-policy-report-only'), plain.get('content-security-policy-report-only'), encoding);
    }
  });

  test('the service worker has its own, narrower policy', async () => {
    const { response } = await page('/sw.js', { accept: '*/*' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), WORKER_POLICY);
    // Chromium loads the push notification's icon (sw.js: showNotification) under this policy; without img-src it is refused.
    assert.ok((directives(response.headers.get('content-security-policy') ?? '').get('img-src') ?? []).includes("'self'"), 'the notification icon loads');
    // A test deployment's worker also sends the same policy as report-only with the report address, so the stack's list sees what the worker is refused.
    const reportOnly = response.headers.get('content-security-policy-report-only');
    if (testDeployment) assert.equal(reportOnly, `${WORKER_POLICY}; report-uri /api/v1/test/csp-reports`);
    else assert.equal(reportOnly, null, 'an install sends the worker no report-only policy');
  });

  test('an API answer keeps the framing policy only', async () => {
    const response = await fetch(new URL('/api/v1/auth/capabilities', apiUrl));
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  });
});

describe('the report list of a test deployment', { skip: testDeployment ? false : 'only a test deployment collects reports' }, () => {
  test('a browser reports without a token, only the bearer reads or clears them, and they stay few', async () => {
    const path = '/api/v1/test/csp-reports';
    const url = new URL(path, apiUrl);
    assert.equal((await fetch(url, { method: 'DELETE', headers: fixtureBearer() })).status, 204);
    const sent = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/csp-report', origin: publicOrigin },
      body: JSON.stringify({ 'csp-report': { 'document-uri': `${publicOrigin}/x`, 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline', 'script-sample': 'alert(1)', 'line-number': 3 } }) });
    assert.equal(sent.status, 204);
    // WebKit sends its reports with `Origin: null`; the origin guard lets this one path through and no other.
    const webkit = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/csp-report', origin: 'null' },
      body: JSON.stringify({ 'csp-report': { 'document-uri': `${publicOrigin}/webkit`, 'effective-directive': 'img-src', 'blocked-uri': 'https://example.invalid/x.png' } }) });
    assert.equal(webkit.status, 204);
    const stillGuarded = await fetch(new URL('/api/auth/sign-in/email', apiUrl), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' });
    assert.equal(stillGuarded.status, 403, 'every other state change still needs the public origin');
    assert.equal((await fetch(url)).status, 401, 'reading needs the bearer');
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 401, 'clearing needs the bearer');
    const listed = await (await fetch(url, { headers: fixtureBearer() })).json() as { reports: Array<{ directive: string; blocked: string; sample: string; line: number | null }> };
    assert.deepEqual(listed.reports.map(({ directive, blocked, sample, line }) => ({ directive, blocked, sample, line })),
      [{ directive: 'script-src-elem', blocked: 'inline', sample: 'alert(1)', line: 3 }, { directive: 'img-src', blocked: 'https://example.invalid/x.png', sample: '', line: null }]);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/csp-report', origin: publicOrigin }, body: 'not json' })).status, 204, 'a malformed report is ignored');
    assert.equal((await fetch(url, { method: 'DELETE', headers: fixtureBearer() })).status, 204);
    assert.deepEqual(((await (await fetch(url, { headers: fixtureBearer() })).json()) as { reports: unknown[] }).reports, []);
  });

  test('a test that refuses something on purpose takes only the reports of that directive off the list', async () => {
    const url = new URL('/api/v1/test/csp-reports', apiUrl);
    const report = (directive: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/csp-report', origin: publicOrigin },
      body: JSON.stringify({ 'csp-report': { 'document-uri': `${publicOrigin}/`, 'effective-directive': directive, 'blocked-uri': publicOrigin } }) });
    const listed = async () => ((await (await fetch(url, { headers: fixtureBearer() })).json()) as { reports: Array<{ directive: string }> }).reports.map((r) => r.directive);
    assert.equal((await fetch(url, { method: 'DELETE', headers: fixtureBearer() })).status, 204);
    await report('frame-ancestors');
    await report('script-src-elem');
    await report('frame-ancestors');
    assert.equal((await fetch(new URL('?directive=frame-ancestors', url), { method: 'DELETE' })).status, 401, 'this needs the bearer too');
    assert.deepEqual(await listed(), ['frame-ancestors', 'script-src-elem', 'frame-ancestors']);
    assert.equal((await fetch(new URL('?directive=frame-ancestors', url), { method: 'DELETE', headers: fixtureBearer() })).status, 204);
    assert.deepEqual(await listed(), ['script-src-elem'], 'the other directive stays for the gate');
    assert.equal((await fetch(url, { method: 'DELETE', headers: fixtureBearer() })).status, 204);
  });
});
