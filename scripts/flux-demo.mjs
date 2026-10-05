/* global fetch, process, console, crypto, URL, setTimeout */
// Demo seed for `./flux demo` (issue #72). Runs with plain Node inside the API container,
// fed on stdin, and talks only to the public HTTP API as two signed-in people, so the
// access policy, idempotency and domain events apply exactly as for real use.
// Development data only: the launcher refuses to run it against a production origin.
//
// Input (environment): FLUX_DEMO_API (default http://127.0.0.1:8080), FLUX_PUBLIC_ORIGIN,
// FLUX_DEMO_OWNER_PASSWORD, FLUX_DEMO_PARTNER_PASSWORD.
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

/** Signs up, or signs in when the account already exists from an earlier `./flux demo`. */
async function account(person) {
  const session = new Session();
  const signUp = await session.request('POST', '/api/auth/sign-up/email', { email: person.email, password: person.password, name: person.name });
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
const owner = await account(people.owner);
const partner = await account(people.partner);

const existing = (await owner.session.expect('GET', '/api/v1/workspaces')).find((ws) => ws.name === WORKSPACE_NAME);
const summary = { workspace: WORKSPACE_NAME, seeded: [], skipped: [], alreadySeeded: Boolean(existing) };
if (existing) {
  console.log(`Demo workspace "${WORKSPACE_NAME}" already exists; nothing new was seeded.`);
} else {
  const ws = await owner.session.expect('POST', '/api/v1/workspaces', { name: WORKSPACE_NAME });
  await owner.session.expect('POST', `/api/v1/workspaces/${ws.id}/members`, { email: partner.email, role: 'member' });
  summary.seeded.push(`workspace "${ws.name}" with ${owner.name} (owner) and ${partner.name} (member)`);

  const project = await owner.session.expect('POST', `/api/v1/workspaces/${ws.id}/projects`, { name: 'Community garden sensors', visibility: 'workspace' });
  summary.seeded.push(`project "${project.name}"`);

  const note = await owner.session.expect('POST', `/api/v1/workspaces/${ws.id}/drafts`, {
    title: 'Before Thursday (private)',
    projectId: project.id,
    body: [
      'Only I can see this note until I share or publish part of it.',
      '',
      '- Budget: the council grant covers 6 sensors, not 10. Ask Jonas if the school can lend two.',
      '- Soil probes corrode within a season; check the capacitive ones.',
      '- My home address is on the shipping form. Redact before sharing anything.',
    ].join('\n'),
  });
  summary.seeded.push(`private note "${note.title}" (visible only to ${owner.name})`);

  const conversationsPath = `/api/v1/projects/${project.id}/conversations`;
  if (await hasRoute(owner.session, conversationsPath)) {
    // Published material copies only the chosen text from the private note, never the whole note.
    const material = await owner.session.expect('POST', `/api/v1/projects/${project.id}/materials`, {
      clientMutationId: ids(),
      title: 'Sensor shortlist',
      body: 'Capacitive soil moisture probe (no exposed metal), DS18B20 temperature probe, '
        + 'ESP32 board with LoRa for the far beds. About 18 EUR per bed.',
      sourceDraftId: note.id,
      sourceDraftVersion: note.version,
    });
    summary.seeded.push(`published material "${material.title}"`);

    const thread = await owner.session.expect('POST', conversationsPath, {
      body: 'Should the first sensors measure soil moisture, or only temperature for the frost warnings?', clientMessageId: ids(),
    });
    const replies = [
      [partner, 'Moisture first. The volunteers keep overwatering the raised beds, and frost is only a spring problem.'],
      [owner, 'Agreed. I compared probes in the shortlist; the capacitive one should survive a season outdoors.', { materialId: material.materialId, version: material.version }],
      [partner, 'Then let us order six and put two on the far beds to test the LoRa range. I can ask the school about two more.'],
    ];
    const said = [];
    for (const [person, body, source] of replies) {
      said.push(await person.session.expect('POST', `/api/v1/conversations/${thread.id}/messages`, { body, clientMessageId: ids(), ...(source ? { source } : {}) }));
    }
    summary.seeded.push(`conversation with ${replies.length + 1} messages between ${owner.name} and ${partner.name}, one citing the material`);
    summary.conversationId = thread.id;
    summary.messageIds = said.map((message) => message.id).filter(Boolean);
    summary.materialRef = { type: 'material', id: material.materialId, version: material.version };
  } else {
    summary.skipped.push('conversation: this build has no conversation API yet (#36)');
  }

  const sketchesPath = `/api/v1/workspaces/${ws.id}/sketches`;
  if (await hasRoute(owner.session, sketchesPath)) {
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
    summary.seeded.push(`sketch "${sketch.title}" with ${thoughts.length + 1} connected thoughts`);
  } else {
    summary.skipped.push('sketch: this build has no sketch API yet (#69)');
  }

  // A 1:1 direct message (#107): only Ada and Jonas can read it, outside the project.
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

  const docsPath = `/api/v1/projects/${project.id}/docs`;
  if (await hasRoute(owner.session, docsPath)) {
    // A project doc with two immutable versions: Ada starts it, Jonas publishes an update.
    const doc = await owner.session.expect('POST', docsPath, {
      title: 'How the garden sensors work',
      body: [
        '## Sensors', '',
        '- Capacitive soil moisture probe in each raised bed',
        '- DS18B20 temperature probe for the frost warnings', '',
        '## Radio', '',
        'The far beds report over LoRa. Range is not tested yet.',
      ].join('\n'),
      reason: 'First notes from the shortlist',
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
      state: 'published',
      reason: 'Added the LoRa range test',
    }, [200], { 'if-match': `"${doc.version}"`, 'idempotency-key': ids() });
    summary.seeded.push(`doc "${doc.title}" with ${updated.version} versions by ${owner.name} and ${partner.name}`);
  } else {
    summary.skipped.push('doc: this build has no docs API yet (#112)');
  }
  // What the project is for, the work people own and one decision waiting for Ada (#272 F-023): the demo
  // shows Flux's Home, a project's goal and its tasks as they are meant to be used, not empty screens.
  const projectPath = `/api/v1/projects/${project.id}`;
  const current = await owner.session.request('GET', projectPath);
  if (current.status === 200 && 'goal' in (current.json ?? {})) {
    await owner.session.expect('PATCH', projectPath, { goal: 'Know when each bed needs water, with six sensors from the council grant' }, [200], { 'if-match': `"${current.json.version}"` });
    summary.seeded.push('the project goal');
  } else {
    summary.skipped.push('project goal: this build has no goal yet (#272)');
  }
  const workPath = `/api/v1/projects/${project.id}/work`;
  if (await hasRoute(owner.session, workPath)) {
    const fromChat = summary.messageIds?.length ? [{ type: 'message', id: summary.messageIds[2] ?? summary.messageIds[0] }] : [];
    const tasks = [
      { title: 'Order six capacitive probes', owner, status: 'in_progress', outcome: 'Six probes on the shed shelf, receipts in the wiki', sources: [...fromChat, ...(summary.materialRef ? [summary.materialRef] : [])] },
      { title: 'Design an enclosure volunteers can open without tools', owner, status: 'blocked', blocker: 'the probe dimensions from the supplier' },
      { title: 'Ask the school to lend two ESP32 kits', owner: partner, status: 'open', sources: fromChat },
      { title: 'Test LoRa range through the hedge', owner: partner, status: 'done', outcome: 'Two sensors reach the gateway from 140 m' },
      { title: 'Write the watering guide for volunteers', owner: null, status: 'open' },
    ];
    for (const task of tasks) {
      await owner.session.expect('POST', workPath, {
        title: task.title, status: task.status, owner: task.owner ? { kind: 'human', id: task.owner.id } : null,
        ...(task.outcome ? { outcome: task.outcome } : {}), ...(task.blocker ? { blocker: task.blocker } : {}), ...(task.sources?.length ? { sources: task.sources } : {}),
        clientCommandId: ids(),
      }, [201], { 'idempotency-key': ids() });
    }
    summary.seeded.push(`${tasks.length} tasks with owners and states (one blocked, with its reason)`);
    const decision = await partner.session.request('POST', `/api/v1/projects/${project.id}/decisions`, {
      title: 'Measure soil moisture first; frost warnings come later',
      rationale: 'Volunteers overwater the raised beds now, and frost only matters in spring.',
      ...(summary.messageIds?.length ? { sources: [{ type: 'message', id: summary.messageIds[0] }] } : {}),
    }, { 'idempotency-key': ids() });
    if (decision.status === 201) summary.seeded.push(`a decision ${partner.name} proposed, waiting for ${owner.name}`);
    else summary.skipped.push(`decision: answered ${decision.status}`);
  } else {
    summary.skipped.push('tasks: this build has no work API yet (#101)');
  }
}

for (const line of summary.seeded) console.log(`  seeded  ${line}`);
for (const line of summary.skipped) console.log(`  skipped ${line}`);
summary.accounts = [owner, partner].map(({ name, email }) => ({ name, email }));
if (process.env.FLUX_DEMO_JSON === '1') console.log(`FLUX_DEMO_RESULT ${JSON.stringify(summary)}`);
