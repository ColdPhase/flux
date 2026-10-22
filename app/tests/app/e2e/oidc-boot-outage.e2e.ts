import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium } from 'playwright';
import { mcpUrl, origin, startFluxProxy } from '../support/mcp-client-harness.js';

// The runner starts Flux without Keycloak, then starts the REAL Keycloak only after this file
// observes the outage. The same page must recover; neither API nor browser is restarted/reloaded.
test('real Keycloak boot outage recovers on the same signed authorization page', async () => {
  const { pool } = createDatabase(process.env.DATABASE_URL!);
  const proxy = startFluxProxy(); await proxy.listen();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let createdUserId: string | undefined;
  try {
    const clientId = `outage-${randomUUID()}`; const redirect = 'http://127.0.0.1:19847/callback';
    await pool.query(`INSERT INTO oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce)
      VALUES ($1, $2, 'Outage client', $3, 'none', '{authorization_code,refresh_token}', '{code}', '{flux.context.read,offline_access}', true)`, [randomUUID(), clientId, [redirect]]);
    await pool.query('INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES ($1, $2, $3)', [randomUUID(), clientId, mcpUrl]);
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL('/api/auth/oauth2/authorize', origin);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      state: randomUUID(), scope: 'flux.context.read offline_access', resource: mcpUrl }).toString();
    const page = await browser.newPage(); await page.goto(url.toString());
    // A reload would drop this marker; the URL equality below alone cannot tell a reload from no reload.
    await page.evaluate(() => { (window as unknown as { __noReload: string }).__noReload = 'same-document'; });
    assert.equal(new URL(page.url()).pathname, '/login');
    const signed = page.url(); assert.ok(new URL(signed).searchParams.get('sig'));
    const signIn = page.getByRole('button', { name: 'Sign in with Keycloak', exact: true });
    await page.getByText('Keycloak is not reachable right now. Try again in a moment.').waitFor();
    assert.equal(await signIn.isDisabled(), true);
    assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0);
    const down = await page.request.get(`${origin}/api/v1/auth/capabilities`);
    assert.equal((await down.json() as { sso: { reachable: boolean } }).sso.reachable, false);
    console.log('OIDC_BOOT_OUTAGE_OBSERVED');
    // check_oidc.sh now starts the actual IdP. The app's ordinary retry/poll path does the recovery.
    await signIn.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const button = document.querySelector('.auth__sso button') as HTMLButtonElement | null;
      return button !== null && !button.disabled;
    }, undefined, { timeout: 120_000 });
    assert.equal(page.url(), signed, 'no reload/navigation lost or replaced the signed continuation');
    assert.equal(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload), 'same-document', 'the document was never reloaded');
    await signIn.click(); await page.waitForURL((target) => target.origin === 'http://keycloak:8080');
    await page.locator('#username').fill('erin'); await page.locator('#password').fill(process.env.FLUX_OIDC_TEST_PASSWORD!);
    await page.locator('#kc-login').click();
    await page.waitForURL(`${origin}/connect-agent?**`, { timeout: 30_000 });
    assert.ok(new URL(page.url()).searchParams.get('sig'), 'the recovered provider round trip preserves continuation');
    const me = await page.request.get(`${origin}/api/v1/me`);
    assert.equal(me.status(), 200, 'the genuine provider callback signed the person in');
    createdUserId = (await me.json() as { user: { id: string } }).user.id;
  } finally {
    await browser.close(); await proxy.close();
    // This is the first browser on the fresh disposable database. Keep the following migration
    // suite's original empty-provider-account precondition: remove only the account this verified
    // callback created, after all outage/recovery assertions, never manufacture a sign-in state.
    if (createdUserId) await pool.query('DELETE FROM auth_users WHERE id = $1', [createdUserId]);
    await pool.end();
  }
});
