// Genuine browser-returned endpoint/provider path, when Chrome's service is available.
// Automated permission configuration and a container window are never phone evidence.
import { createHash } from 'node:crypto';
import { readJson, readState, writeJson, privateDirectory, publicOrigin } from './state.mjs';
import { signedIn } from './helper.mjs';

const directory = process.env.MOBILE_STATE ?? '/state';
const webdriver = 'http://desktop-browser:4444';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
async function command(method, path, body) {
  const response = await fetch(`${webdriver}${path}`, { method, signal: AbortSignal.timeout(45_000),
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`WebDriver operation failed with HTTP ${response.status}; no command body or browser detail is exported`);
  return result.value;
}
async function sessionCommand(session, method, path, body) { return command(method, `/session/${session}${path}`, body); }
async function script(session, source, args = []) { return sessionCommand(session, 'POST', '/execute/async', { script: source, args }); }
async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webdriver}/status`, { signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json()).value?.ready) return;
    } catch { /* Startup only: bounded readiness polling without exporting Grid errors. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Desktop WebDriver did not become ready within 60 seconds');
}
async function subscribe(state) {
  if (state.boundaryReview !== state.candidate) throw new Error('Desktop provider probe requires the reviewed HTTPS fixture');
  publicOrigin(state.origin);
  const tls = await readJson(directory, 'https-verification.json');
  if (!tls.trustedTls || tls.candidate !== state.candidate || tls.image !== state.image || tls.origin !== state.origin) throw new Error('Verify the exact HTTPS origin/image first');
  const secret = await readJson(directory, 'secrets.json');
  await ready();
  // This configures consent for a bounded software transport probe; the normal Flux button
  // still calls the real browser API. No TLS exception, fake endpoint or Push API replacement.
  const created = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'chrome', acceptInsecureCerts: false,
    'goog:chromeOptions': { excludeSwitches: ['disable-background-networking', 'disable-notifications'], prefs: { 'profile.default_content_setting_values.notifications': 1 } } } } });
  const session = created.sessionId;
  try {
    await sessionCommand(session, 'POST', '/timeouts', { script: 40_000, pageLoad: 40_000, implicit: 0 });
    await sessionCommand(session, 'POST', '/url', { url: state.origin });
    const login = await script(session, `const done=arguments[arguments.length-1]; fetch('/api/auth/sign-in/email', {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify(arguments[0])}).then(r=>done(r.status)).catch(()=>done(0));`, [{ email: secret.recipient.email, password: secret.recipient.password }]);
    if (login !== 200) throw new Error('Normal browser sign-in failed');
    await sessionCommand(session, 'POST', '/url', { url: `${state.origin}/settings/notifications` });
    const deadline = Date.now() + 45_000; let button;
    while (Date.now() < deadline) {
      const buttons = await sessionCommand(session, 'POST', '/elements', { using: 'xpath', value: '//button[contains(normalize-space(.), "Turn on notifications")]' });
      if (buttons.length) { button = buttons[0][elementKey]; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!button) throw new Error('Normal Flux notification consent button was not available');
    await sessionCommand(session, 'POST', `/element/${button}/click`, {});
    let evidence;
    while (Date.now() < deadline) {
      evidence = await script(session, `const done=arguments[arguments.length-1]; navigator.serviceWorker.ready.then(async r=>{const s=await r.pushManager.getSubscription(); const me=await fetch('/api/v1/me').then(r=>r.json()); const saved=await fetch('/api/v1/push/subscriptions').then(r=>r.json()); done({providerOrigin:s?new URL(s.endpoint).origin:null, saved:Array.isArray(saved)?saved.length:0, session:me.session?.id, permission:Notification.permission, userAgent:navigator.userAgent});}).catch(()=>done({failed:true}));`);
      if (evidence?.providerOrigin && evidence.saved && evidence.session) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!evidence?.providerOrigin || !evidence.saved || !evidence.session) throw new Error('Actual browser/provider subscription unavailable; do not replace it with a fixture endpoint');
    await writeJson(directory, 'browser-state.json', { webdriverSession: session, fluxSession: evidence.session, candidate: state.candidate, origin: state.origin });
    const result = { at: new Date().toISOString(), candidate: state.candidate, image: state.image, browserImage: state.browserImage,
      providerOrigin: evidence.providerOrigin, userAgent: evidence.userAgent, permission: evidence.permission,
      consent: 'Automated Chrome preference plus actual Flux button click; physical consent unverified',
      limitation: 'Desktop container software proof only; no physical Android/iPhone/iPad installation or OS display evidence' };
    await writeJson(directory, 'desktop-provider-subscription.json', result);
    await sessionCommand(session, 'POST', '/url', { url: 'about:blank' });
    return result;
  } catch (error) { await command('DELETE', `/session/${session}`).catch(() => {}); throw error; }
}
async function notifications(state) {
  const browser = await readJson(directory, 'browser-state.json');
  if (browser.candidate !== state.candidate || browser.origin !== state.origin) throw new Error('Browser source/origin changed');
  try { await sessionCommand(browser.webdriverSession, 'POST', '/url', { url: state.origin }); }
  catch { throw new Error('Browser notification inspection could not navigate to the verified origin within its deadline'); }
  let shown;
  try {
    shown = await script(browser.webdriverSession, `const done=arguments[arguments.length-1]; navigator.serviceWorker.getRegistration('/').then(async r=>done(r?(await r.getNotifications()).map(n=>n.tag):null)).catch(()=>done(null));`);
  } catch { throw new Error('Browser notification registration/records inspection exceeded its deadline'); }
  if (!Array.isArray(shown)) throw new Error('Browser service-worker notification inspection unavailable');
  const result = { candidate: state.candidate, at: new Date().toISOString(), notificationAliases: shown.map(hash),
    limitation: 'Browser notification records only; never a physical lock-screen/OS display claim' };
  await writeJson(directory, 'desktop-provider-notifications.json', result); return result;
}
async function stop(state) {
  const browser = await readJson(directory, 'browser-state.json');
  const { client } = await signedIn(directory, state, 'recipient');
  try { await client.request('DELETE', `/api/v1/sessions/${browser.fluxSession}`, undefined, 204); }
  finally { await client.request('POST', '/api/auth/sign-out', {}); await command('DELETE', `/session/${browser.webdriverSession}`).catch(() => {}); }
  return { browserStopped: true, fixtureSessionRevoked: true };
}
try {
  await privateDirectory(directory); const state = await readState(directory); const action = process.argv[2];
  console.log(JSON.stringify(await ({ subscribe, notifications, stop }[action] ?? (() => { throw new Error('Unknown desktop provider command'); }))(state), null, 2));
} catch (error) { console.error(`Desktop provider probe failed: ${error.message}`); process.exitCode = 1; }
