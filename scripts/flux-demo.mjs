/* global fetch, process, console, crypto, URL, setTimeout */
// Demo seed for `./flux demo` (issue #72). Runs with plain Node inside the API container,
// fed on stdin, and talks only to the public HTTP API as two signed-in people, so the
// access policy, idempotency and domain events apply exactly as for real use.
// Development data only: the launcher refuses to run it against a production origin.
//
// Input (environment): FLUX_DEMO_API (default http://127.0.0.1:8080), FLUX_PUBLIC_ORIGIN,
// FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD, FLUX_SETUP_TOKEN (#1471: the owner's account comes from the setup
// link, the partner's from an invite link the owner makes, as for real use).
// Output: human-readable progress on stdout; with FLUX_DEMO_JSON=1 also a final
// `FLUX_DEMO_RESULT {json}` line for scripts/check_flux_cli.sh.

const api = process.env.FLUX_DEMO_API ?? 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const WORKSPACE_NAME = 'Riverside Makers (demo)';
const people = {
  owner: { name: 'Ada Kowalska', email: 'ada@demo.flux.test', password: process.env.FLUX_DEMO_OWNER_PASSWORD },
  partner: { name: 'Jonas Berg', email: 'jonas@demo.flux.test', password: process.env.FLUX_DEMO_PARTNER_PASSWORD },
};
if (!origin) fail('FLUX_PUBLIC_ORIGIN is required');
for (const person of Object.values(people)) if (!person.password) fail(`No demo password for ${person.email}`);

function fail(message) {
  console.error(`demo: ${message}`);
  process.exit(1);
}

/** One browser: a cookie jar that sends the configured public Origin like a real page. */
class Session {
  cookies = new Map();

  async request(method, path, body, extra = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { origin, ...extra };
      if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(new URL(path, api), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value) this.cookies.set(name, value); else this.cookies.delete(name);
      }
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      // The login rate limit is on by default; wait it out instead of failing the seed.
      if (response.status === 429 && attempt < 5) {
        const seconds = Number(response.headers.get('retry-after')) || 10;
        console.log(`  (rate limited, retrying in ${seconds}s)`);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }
      return { status: response.status, json, text };
    }
  }

  async expect(method, path, body, status = [200, 201], extra = {}) {
    const response = await this.request(method, path, body, extra);
    if (!status.includes(response.status)) fail(`${method} ${path} answered ${response.status}: ${response.text}`);
    return response.json;
  }
}

/** Signs up from the given link, or signs in when the account already exists from an earlier `./flux demo`. */
async function account(person, link = {}) {
  const session = new Session();
  const signUp = await session.request('POST', '/api/auth/sign-up/email', { email: person.email, password: person.password, name: person.name, ...link });
  if (signUp.status !== 200) {
    const signIn = await session.request('POST', '/api/auth/sign-in/email', { email: person.email, password: person.password });
    if (signIn.status !== 200) {
      fail(`${person.email} exists but its password differs from the one in the env file (sign-in answered ${signIn.status}). `
        + 'Run ./flux reset to start from empty data, then ./flux demo.');
    }
  }
  const me = await session.expect('GET', '/api/v1/me');
  return { ...person, session, id: me.user.id, created: signUp.status === 200 };
}

/** Feature detection: an unregistered route answers the generic 404 without a domain error code. */
async function hasRoute(session, path) {
  const response = await session.request('GET', path);
  return !(response.status === 404 && !response.json?.code);
}

const ids = () => crypto.randomUUID();
const setupToken = process.env.FLUX_SETUP_TOKEN || undefined;
const owner = await account(people.owner, setupToken ? { setupToken } : {});

// F-037: one Flux is one company, set up by its first account. On a fresh install the demo owner signs up first and
// owns it; the demo names it and adds the partner. On a server someone else set up, the demo stops instead.
const company = (await owner.session.expect('GET', '/api/v1/workspaces')).find((ws) => ws.company);
if (!company || (company.role !== 'owner' && company.role !== 'admin')) {
  fail('this Flux already belongs to another company. Run ./flux reset to start from empty data, then ./flux demo.');
}
const existing = company.name === WORKSPACE_NAME ? company : null;
const summary = { workspace: WORKSPACE_NAME, seeded: [], skipped: [], alreadySeeded: Boolean(existing) };
// The partner joins from an invite link for their address (#1471), or signs in when an earlier demo made the account.
let partner;
if (existing) partner = await account(people.partner);
else {
  const invite = await owner.session.expect('POST', `/api/v1/workspaces/${company.id}/invites`, { role: 'member', email: people.partner.email }, [201]);
  partner = await account(people.partner, { inviteToken: new URL(invite.link).hash.slice(1) });
  const joined = (await partner.session.expect('GET', '/api/v1/workspaces')).some((ws) => ws.id === company.id);
  if (!joined) await owner.session.expect('POST', `/api/v1/workspaces/${company.id}/members`, { email: partner.email, role: 'member' }, [200, 201]);
}
if (existing) {
  console.log(`Demo company "${WORKSPACE_NAME}" already exists; nothing new was seeded.`);
} else {
  const ws = await owner.session.expect('PATCH', `/api/v1/workspaces/${company.id}`, { name: WORKSPACE_NAME });
  summary.seeded.push(`company "${ws.name}" with ${owner.name} (owner) and ${partner.name} (member)`);

  const project = await owner.session.expect('POST', `/api/v1/workspaces/${ws.id}/projects`, { name: 'Community garden sensors' });
  await owner.session.expect('POST', `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'human', id: partner.id }, role: 'contributor' });
  summary.seeded.push(`space "${project.name}" with both of them`);

  const conversationsPath = `/api/v1/projects/${project.id}/conversations`;
  const docsPath = `/api/v1/projects/${project.id}/docs`;
  if (await hasRoute(owner.session, conversationsPath)) {
    // The shortlist the conversation cites is a Wiki page (a saved source is a Wiki page, #1419 item 20).
    const shortlist = await hasRoute(owner.session, docsPath)
      ? await owner.session.expect('POST', docsPath, {
        title: 'Sensor shortlist',
        body: 'Capacitive soil moisture probe (no exposed metal), DS18B20 temperature probe, '
          + 'ESP32 board with LoRa for the far beds. About 18 EUR per bed.',
      }, [201], { 'idempotency-key': ids() })
      : null;
    if (shortlist) summary.seeded.push(`Wiki page "${shortlist.title}" for a message to cite`);

    const thread = await owner.session.expect('POST', conversationsPath, {
      body: 'Should the first sensors measure soil moisture, or only temperature for the frost warnings?', clientMessageId: ids(),
    });
    const replies = [
      [partner, 'Moisture first. The volunteers keep overwatering the raised beds, and frost is only a spring problem.'],
      [owner, 'Agreed. I compared probes in the shortlist; the capacitive one should survive a season outdoors.', shortlist ? { materialId: shortlist.id, version: shortlist.version } : undefined],
      [partner, 'Then let us order six and put two on the far beds to test the LoRa range. I can ask the school about two more.'],
    ];
    for (const [person, body, source] of replies) {
      await person.session.expect('POST', `/api/v1/conversations/${thread.id}/messages`, { body, clientMessageId: ids(), ...(source ? { source } : {}) });
    }
    summary.seeded.push(`conversation with ${replies.length + 1} messages between ${owner.name} and ${partner.name}, ${shortlist ? 'one citing the Wiki page' : 'none citing a page'}`);
    summary.conversationId = thread.id;
  } else {
    summary.skipped.push('conversation: this build has no conversation API yet (#36)');
  }

  const sketchesPath = `/api/v1/workspaces/${ws.id}/sketches`;
  if (await hasRoute(owner.session, sketchesPath)) {
    // A space's Map (the API still calls it a sketch with the scope `project`).
    const sketch = await owner.session.expect('POST', sketchesPath, { title: 'Where the sensors go', scope: 'project', projectId: project.id });
    const add = (command) => owner.session.expect('POST', `/api/v1/sketches/${sketch.id}/thoughts`, command);
    const root = await add({ text: 'Six sensors for twelve beds', x: 0, y: 0 });
    const thoughts = [
      ['Raised beds by the fence: overwatered', 'problem'],
      ['Far beds: test LoRa range first', 'range'],
      ['Borrow two sensors from the school?', 'budget'],
    ];
    for (const [index, [text, label]] of thoughts.entries()) {
      await add({ text, x: 260, y: (index - 1) * 110, linkFrom: { thoughtId: root.thought.id, label } });
    }
    summary.seeded.push(`map "${sketch.title}" with ${thoughts.length + 1} connected thoughts`);
  } else {
    summary.skipped.push('map: this build has no map API yet (#69)');
  }

  // A 1:1 direct message (#107): only Ada and Jonas can read it, outside every space.
  const dmsPath = `/api/v1/workspaces/${ws.id}/dms`;
  if (await hasRoute(owner.session, dmsPath)) {
    const dm = await owner.session.expect('POST', dmsPath, { participantIds: [partner.id] });
    const lines = [
      [owner, 'Quick one before Thursday: the grant only covers six sensors. Could the school lend us two more?'],
      [partner, 'I can ask Ms. Novak tomorrow. They have a few ESP32 kits from the robotics club.'],
      [owner, 'Great. Let us keep it between us until she says yes, so nobody plans around it yet.'],
      [partner, 'Agreed. I will message you here as soon as I know.'],
    ];
    for (const [person, body] of lines) {
      await person.session.expect('POST', `/api/v1/dms/${dm.id}/messages`, { body, clientMessageId: ids() });
    }
    summary.seeded.push(`direct message between ${owner.name} and ${partner.name} with ${lines.length} messages (only they can read it)`);
    summary.dmId = dm.id;
  } else {
    summary.skipped.push('direct message: this build has no direct-message API yet (#107)');
  }

  if (await hasRoute(owner.session, docsPath)) {
    // A Wiki page of the space with two versions: Ada starts it, Jonas saves an update.
    const doc = await owner.session.expect('POST', docsPath, {
      title: 'How the garden sensors work',
      body: [
        '## Sensors', '',
        '- Capacitive soil moisture probe in each raised bed',
        '- DS18B20 temperature probe for the frost warnings', '',
        '## Radio', '',
        'The far beds report over LoRa. Range is not tested yet.',
      ].join('\n'),
    }, [201], { 'idempotency-key': ids() });
    const updated = await partner.session.expect('PATCH', `/api/v1/docs/${doc.id}`, {
      body: [
        '## Sensors', '',
        '- Capacitive soil moisture probe in each raised bed (no exposed metal)',
        '- DS18B20 temperature probe for the frost warnings', '',
        '## Radio', '',
        'The far beds report over LoRa. Two sensors reached the gateway from 140 m through the hedge.',
        '',
        '| Bed | Distance | Signal |', '| --- | ---: | --- |', '| Far east | 140 m | ok |', '| Shed | 60 m | strong |',
      ].join('\n'),
    }, [200], { 'if-match': `"${doc.version}"`, 'idempotency-key': ids() });
    summary.seeded.push(`Wiki page "${doc.title}" with ${updated.version} versions by ${owner.name} and ${partner.name}`);
  } else {
    summary.skipped.push('Wiki page: this build has no Wiki API yet (#112)');
  }
}

for (const line of summary.seeded) console.log(`  seeded  ${line}`);
for (const line of summary.skipped) console.log(`  skipped ${line}`);
summary.accounts = [owner, partner].map(({ name, email }) => ({ name, email }));
if (process.env.FLUX_DEMO_JSON === '1') console.log(`FLUX_DEMO_RESULT ${JSON.stringify(summary)}`);
