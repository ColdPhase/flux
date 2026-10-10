import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { before, describe, test } from 'node:test';
import Fastify from 'fastify';
import {
  NOTIFICATION_PREFERENCES_PATH,
  PROJECT_EXPORT_EXCLUDED,
  PROJECT_EXPORT_JSON_SCHEMA,
  projectExportPath,
  type Conversation,
  type Decision,
  type Doc,
  type NotificationPreferences,
  type ProjectExport,
  type ProjectExportManifest,
  type Project,
  type WorkItem,
  type WorkResult,
  type Workspace,
} from '@flux/contracts';
import { Browser, type ClientResponse } from './support/http.js';
import { addMember, draft, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// Project export (issue #123): only a manager exports; the document and bundle hold the
// project's conversation, materials and docs with versions, project sketches with thoughts and
// links, work, decisions and results with links, members and provenance, and never another
// project, a DM, a private note or a private sketch (checked with distinctive tokens).

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;

// The partner's quiet hours (#116) must stay out of the export. A bare clock time such as 21:15
// also occurs in every instant written at that minute ("…T21:15:03.000Z"), so a run at 21:15 UTC
// failed (#365). The markers are the JSON string values, quotes included, which an instant never
// forms; the control test below shows they still catch the preferences.
const QUIET_HOURS_MARKERS = ['Pacific/Chatham', '"21:15"', '"07:05"'] as const;
const leaked = (text: string, markers: readonly string[]) => markers.filter((marker) => text.includes(marker));

/** Reads a ustar archive: path → content. */
function untar(archive: Buffer) {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8);
    const stored = block.subarray(148, 156).toString('ascii').replace(/[\0 ]+$/, '');
    const sum = [...block].reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(parseInt(stored, 8), sum, `tar checksum of ${name}`);
    files.set(prefix ? `${prefix}/${name}` : name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function validator() {
  // Fastify's own AJV (draft-07 with formats), strict: nothing removed or coerced.
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: true } } });
  app.post('/validate', { schema: { body: PROJECT_EXPORT_JSON_SCHEMA } }, async () => ({ ok: true }));
  await app.ready();
  return async (document: unknown) => {
    const response = await app.inject({ method: 'POST', url: '/validate', payload: document as object });
    return { valid: response.statusCode === 200, errors: response.body };
  };
}

describe('project export', () => {
  const tag = randomUUID().slice(0, 8);
  const token = (what: string) => `${what}-${tag}`;
  let owner: Person;
  let admin: Person;
  let partner: Person;
  let viewer: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let other: Project;
  let conversation: Conversation;
  let materialId: string;
  let doc: Doc;
  let sketchId: string;
  let thoughtIds: string[];
  let work: WorkItem;
  let decision: Decision;
  let result: WorkResult;
  let privateDraftId: string;
  let materialMutationId: string;
  let agentId: string;
  let connectionId: string;

  before(async () => {
    [owner, admin, partner, viewer, outsider] = await Promise.all(['export-owner', 'export-admin', 'export-partner', 'export-viewer', 'export-outsider'].map(person));
    ws = await workspace(owner, `Export space ${tag}`);
    await addMember(owner, ws.id, admin, 'admin');
    await addMember(owner, ws.id, partner, 'member');
    await addMember(owner, ws.id, viewer, 'member');
    lamp = await createProject(owner, ws.id, `Gesture lamp ${tag}`, 'restricted');
    other = await createProject(owner, ws.id, `Other project ${tag}`, 'workspace');
    await grant(owner, lamp.id, partner, 'contributor');
    await grant(owner, lamp.id, viewer, 'viewer');

    // Private note in the project; a material is published from a redacted part of it.
    const note = await draft(owner, ws.id, token('PRIVATENOTE-title'), { projectId: lamp.id, body: token('PRIVATENOTE-body') });
    privateDraftId = note.id;
    materialMutationId = randomUUID();
    const material = json<{ materialId: string; version: number }>(await post(owner, `/api/v1/projects/${lamp.id}/materials`, {
      clientMutationId: materialMutationId, title: token('MATERIAL-title'), body: token('MATERIAL-body'), sourceDraftId: note.id, sourceDraftVersion: note.version,
    }), 201, 'material');
    materialId = material.materialId;
    json(await owner.browser.request('PATCH', `/api/v1/materials/${materialId}`, {
      body: { clientMutationId: randomUUID(), expectedVersion: 1, body: token('MATERIAL-body-v2') },
    }), 200, 'material v2');

    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: token('MESSAGE-one'), clientMessageId: randomUUID() }), 201, 'conversation');
    json(await post(partner, `/api/v1/conversations/${conversation.id}/messages`,
      { body: token('MESSAGE-two'), clientMessageId: randomUUID(), source: { materialId, version: 1 } }), 201, 'reply');

    const sketch = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/sketches`, { title: token('SKETCH-title'), scope: 'project', projectId: lamp.id }), 201, 'sketch');
    sketchId = sketch.id;
    const root = json<{ thought: { id: string } }>(await post(owner, `/api/v1/sketches/${sketchId}/thoughts`, { text: token('THOUGHT-root'), x: 0, y: 0 }), 201, 'thought');
    const leaf = json<{ thought: { id: string } }>(await post(partner, `/api/v1/sketches/${sketchId}/thoughts`,
      { text: token('THOUGHT-leaf'), x: 240, y: 0, linkFrom: { thoughtId: root.thought.id, label: 'because' } }), 201, 'linked thought');
    thoughtIds = [root.thought.id, leaf.thought.id];
    // A private sketch, placing the private note: never exported.
    const secret = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/sketches`, { title: token('PRIVATESKETCH-title'), scope: 'private' }), 201, 'private sketch');
    json(await post(owner, `/api/v1/sketches/${secret.id}/thoughts`, { text: token('PRIVATESKETCH-thought'), x: 0, y: 0, placement: { type: 'draft', id: note.id } }), 201, 'private thought');

    const messages = json<{ messages: { id: string }[] }>(await owner.browser.request('GET', `/api/v1/conversations/${conversation.id}`), 200).messages;
    work = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, {
      title: token('WORK-title'), owner: { kind: 'human', id: partner.id }, sources: [{ type: 'message', id: messages[0]!.id }, { type: 'thought', id: thoughtIds[0]! }],
    }), 201, 'work');
    decision = json<Decision>(await post(partner, `/api/v1/projects/${lamp.id}/decisions`, { title: token('DECISION-title'), rationale: token('DECISION-rationale'), affects: [work.id] }), 201, 'decision');
    decision = json<Decision>(await post(owner, `/api/v1/decisions/${decision.id}/accept`, {}, { 'if-match': `"${decision.version}"` }), 200, 'accept');
    result = json<WorkResult>(await post(partner, `/api/v1/projects/${lamp.id}/results`, {
      title: token('RESULT-title'), finding: 'negative', evidence: token('RESULT-evidence'), work: [work.id], decisions: [decision.id],
    }), 201, 'result');

    doc = json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: token('DOC-title'), body: token('DOC-v1'), reason: 'First notes' }), 201, 'doc');
    doc = json<Doc>(await partner.browser.request('PATCH', `/api/v1/docs/${doc.id}`, {
      body: { body: `${token('DOC-v2')} see [the root](flux:thought/${thoughtIds[0]}) and [work](flux:work/${work.id})`, state: 'published', reason: 'Linked the map' },
      headers: { 'if-match': `"${doc.version}"` },
    }), 200, 'doc v2');

    // An agent with a grant and an MCP connection selection (#52): the agent is part of the
    // audience, its connection never leaves the instance.
    agentId = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'export-agent', owner: 'self' }), 201, 'agent').id;
    json(await post(owner, `/api/v1/projects/${lamp.id}/grants`, { principal: { kind: 'agent', id: agentId }, role: 'contributor' }), 201, 'agent grant');
    connectionId = json<{ id: string }>(await post(owner, '/api/v1/agent-connections',
      { agentId, selectedProjectIds: [lamp.id], scopes: ['flux.context.read'] }), 201, 'agent connection').id;

    // Notification data of another person (#116): an extra delivery address and preferences.
    const address = await post(partner, '/api/v1/notification-address', { email: token('extra-address') + '@example.test' });
    assert.ok(address.status < 300, `notification address: ${address.status} ${address.text}`);
    json(await partner.browser.request('PATCH', '/api/v1/notification-preferences', {
      body: { quietHours: { enabled: true, start: '21:15', end: '07:05', timeZone: 'Pacific/Chatham' } },
    }), 200, 'notification preferences');
    json(await partner.browser.request('PUT', '/api/v1/notification-preferences/mutes', { body: { type: 'project', id: lamp.id, muted: true } }), 200, 'mute');

    // Content that must stay out: another project, a DM, a workspace-level private note.
    json(await post(owner, `/api/v1/projects/${other.id}/conversations`, { body: token('OTHERPROJECT-message'), clientMessageId: randomUUID() }), 201, 'other conversation');
    json(await post(owner, `/api/v1/projects/${other.id}/docs`, { title: token('OTHERPROJECT-doc'), body: token('OTHERPROJECT-doc-body') }), 201, 'other doc');
    const dm = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/dms`, { participantIds: [partner.id] }), 201, 'dm');
    json(await post(owner, `/api/v1/dms/${dm.id}/messages`, { body: token('DMSECRET-message'), clientMessageId: randomUUID() }), 201, 'dm message');
    await draft(owner, ws.id, token('PRIVATENOTE-workspace'), { body: token('PRIVATENOTE-workspace-body') });
  });

  test('only a project manager can export; others get 403, an outsider 404', async () => {
    assert.equal((await outsider.browser.request('GET', projectExportPath(lamp.id))).status, 404);
    for (const someone of [partner, viewer]) assert.equal((await someone.browser.request('GET', projectExportPath(lamp.id))).status, 403);
    assert.equal((await outsider.browser.request('GET', `${projectExportPath(lamp.id)}?format=bundle`)).status, 404);
    assert.equal((await new Browser().request('GET', projectExportPath(lamp.id))).status, 401);
    assert.equal((await admin.browser.request('GET', projectExportPath(lamp.id))).status, 200, 'a workspace admin manages every project');
  });

  test('the document holds the project with versions, sketches, work and links, and nothing else', async () => {
    const response = await owner.browser.request('GET', projectExportPath(lamp.id));
    const data = json<ProjectExport>(response, 200, 'export');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual([data.format, data.formatVersion, data.provenance.reimportSupported], ['flux.project-export', 1, false]);
    assert.deepEqual(data.excluded, [...PROJECT_EXPORT_EXCLUDED]);
    assert.deepEqual([data.provenance.exportedBy.id, data.provenance.exportedBy.name], [owner.id, 'export-owner']);
    assert.ok(data.provenance.schemaVersion >= 13);
    assert.deepEqual([data.project.id, data.project.name, data.project.visibility, data.project.workspace.id], [lamp.id, lamp.name, 'restricted', ws.id]);

    const people = new Map(data.people.map((someone) => [someone.id, [someone.access, someone.workspaceRole]]));
    assert.deepEqual(people.get(owner.id), ['manager', 'owner']);
    assert.deepEqual(people.get(admin.id), ['manager', 'admin']);
    assert.deepEqual(people.get(partner.id), ['contributor', 'member']);
    assert.deepEqual(people.get(viewer.id), ['viewer', 'member']);
    assert.equal(people.has(outsider.id), false);
    assert.deepEqual(data.grants.map((item) => [item.principal.id, item.role]).sort(), [[agentId, 'contributor'], [partner.id, 'contributor'], [viewer.id, 'viewer']].sort());
    assert.deepEqual(data.people.find((someone) => someone.id === agentId), { kind: 'agent', id: agentId, name: 'export-agent', access: 'contributor', workspaceRole: null });

    // The ordinary thread, and the work item's own thread that the result linked to it (#154) created.
    assert.equal(data.conversations.length, 2);
    assert.deepEqual(data.conversations[0]!.messages.map((message) => [message.sequence, message.body, message.author.id]),
      [[1, token('MESSAGE-one'), owner.id], [2, token('MESSAGE-two'), partner.id]]);
    assert.deepEqual(data.conversations[0]!.messages[1]!.source, { materialId, version: 1 });
    assert.equal(data.conversations[0]!.messages.some((message) => Object.hasOwn(message, 'contribution')), false, 'ordinary messages carry no marker');
    assert.deepEqual(data.conversations[1]!.messages.map((message) => [message.sequence, message.body, message.author.id, message.contribution]),
      [[1, token('RESULT-title'), partner.id, { kind: 'result', resultId: result.id }]]);

    assert.equal(data.materials.length, 1);
    assert.deepEqual(data.materials[0]!.versions.map((version) => [version.version, version.body]), [[1, token('MATERIAL-body')], [2, token('MATERIAL-body-v2')]]);
    assert.equal(data.materials[0]!.currentVersion, 2);

    assert.equal(data.docs.length, 1);
    assert.deepEqual(data.docs[0]!.versions.map((version) => [version.version, version.state, version.reason, version.author.id]),
      [[1, 'draft', 'First notes', owner.id], [2, 'published', 'Linked the map', partner.id]]);
    assert.equal(data.docs[0]!.file, `docs/${doc.id}.md`);

    assert.equal(data.sketches.length, 1);
    assert.deepEqual(data.sketches[0]!.thoughts.map((thought) => thought.text), [token('THOUGHT-root'), token('THOUGHT-leaf')]);
    assert.deepEqual(data.sketches[0]!.links.map((link) => [link.fromId, link.toId, link.label]), [[thoughtIds[0], thoughtIds[1], 'because']]);

    assert.deepEqual(data.work.map((item) => [item.id, item.owner?.id]), [[work.id, partner.id]]);
    assert.deepEqual(data.decisions.map((item) => [item.id, item.status, item.decidedBy?.id]), [[decision.id, 'accepted', owner.id]]);
    assert.deepEqual(data.results.map((item) => [item.id, item.finding, item.evidence]), [[result.id, 'negative', token('RESULT-evidence')]]);
    const links = data.links.map((link) => `${link.from.type}:${link.role}:${link.to.type}:${link.to.id}`);
    for (const expected of [
      `work:source:thought:${thoughtIds[0]}`, `decision:affects:work:${work.id}`, `result:about:work:${work.id}`, `result:about:decision:${decision.id}`,
      `doc:mentions:thought:${thoughtIds[0]}`, `doc:mentions:work:${work.id}`,
    ]) assert.ok(links.includes(expected), `missing link ${expected} in ${links.join(', ')}`);
    assert.ok(data.links.some((link) => link.from.type === 'work' && link.role === 'source' && link.to.type === 'message'));

    const names = new Map(data.actors.map((actor) => [actor.id, actor.name]));
    for (const [someone, name] of [[owner, 'export-owner'], [partner, 'export-partner']] as const) assert.equal(names.get(someone.id), name);

    const text = JSON.stringify(data);
    assert.deepEqual(leaked(text, ['OTHERPROJECT', 'DMSECRET', 'PRIVATENOTE', 'PRIVATESKETCH', 'extra-address', ...QUIET_HOURS_MARKERS]), [], 'export leaks');
    for (const hidden of [privateDraftId, materialMutationId, connectionId, other.id, owner.email, partner.email, outsider.id]) assert.ok(!text.includes(hidden), `export leaks ${hidden}`);

    const validate = await validator();
    const checked = await validate(data);
    assert.ok(checked.valid, `export does not match its JSON Schema: ${checked.errors}`);
    const broken = await validate({ ...data, formatVersion: 2 });
    assert.equal(broken.valid, false, 'the schema rejects another format version');
    const extra = await validate({ ...data, dms: [] });
    assert.equal(extra.valid, false, 'the schema rejects unknown top-level parts');
  });

  test('the leak check ignores instants at the quiet-hours minutes and catches the quiet hours themselves (#365)', async () => {
    const data = json<ProjectExport>(await owner.browser.request('GET', projectExportPath(lamp.id)), 200, 'export');
    const preferences = json<NotificationPreferences>(await partner.browser.request('GET', NOTIFICATION_PREFERENCES_PATH), 200, 'preferences');
    assert.deepEqual(preferences.quietHours, { enabled: true, start: '21:15', end: '07:05', timeZone: 'Pacific/Chatham' });
    // The export as a run at 21:15 or 07:05 UTC writes it, every instant at that minute; the old
    // bare '21:15' check failed on exactly this text.
    for (const minute of ['21:15', '07:05']) {
      const text = JSON.stringify(data).replace(/T\d{2}:\d{2}(?=:\d{2}(?:\.\d+)?Z)/g, `T${minute}`);
      assert.ok(text.includes(`T${minute}:`), 'the export carries instants');
      assert.deepEqual(leaked(text, QUIET_HOURS_MARKERS), [], `an instant at ${minute} is not a leak`);
    }
    // Negative control: the same export carrying the partner's preferences is caught on every marker.
    assert.deepEqual(leaked(JSON.stringify({ ...data, notificationPreferences: preferences }), QUIET_HOURS_MARKERS), [...QUIET_HOURS_MARKERS]);
  });

  test('the bundle is a tar.gz with project.json, docs as Markdown, the schema and a checked manifest', async () => {
    const response = await fetch(new URL(`${projectExportPath(lamp.id)}?format=bundle`, process.env.FLUX_API_URL ?? 'http://api:8080'), {
      headers: { cookie: owner.browser.cookieHeader(), origin: process.env.FLUX_PUBLIC_ORIGIN ?? '' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="flux-project-[0-9a-f]{8}-\d{8}T\d{6}Z\.tar\.gz"$/);
    const files = untar(gunzipSync(Buffer.from(await response.arrayBuffer())));
    const root = [...files.keys()][0]!.split('/')[0]!;
    const read = (path: string) => files.get(`${root}/${path}`);
    const manifest = JSON.parse(read('manifest.json')!.toString('utf8')) as ProjectExportManifest;
    assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['README.md', `docs/${doc.id}.md`, 'project.json', 'schema/project-export.v1.schema.json']);
    for (const file of manifest.files) {
      const content = read(file.path)!;
      assert.equal(content.length, file.bytes, `${file.path} size`);
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, `${file.path} checksum`);
    }
    const data = JSON.parse(read('project.json')!.toString('utf8')) as ProjectExport;
    assert.equal(data.project.id, lamp.id);
    assert.equal(read(`docs/${doc.id}.md`)!.toString('utf8'), data.docs[0]!.versions[1]!.body);
    assert.deepEqual(JSON.parse(read('schema/project-export.v1.schema.json')!.toString('utf8')), JSON.parse(JSON.stringify(PROJECT_EXPORT_JSON_SCHEMA)));
    assert.match(read('README.md')!.toString('utf8'), /Re-import into Flux is not supported/);
    const everything = [...files.values()].map((content) => content.toString('utf8')).join('\n');
    for (const hidden of ['OTHERPROJECT', 'DMSECRET', 'PRIVATENOTE', 'PRIVATESKETCH']) assert.ok(!everything.includes(hidden), `bundle leaks ${hidden}`);
  });
});
