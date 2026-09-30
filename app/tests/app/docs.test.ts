import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { DomainError, upsertSection, type Principal } from '@flux/core';
import type { Agent, Conversation, Decision, Doc, DocPreview, DocSummary, DocVersion, DocVersionSummary, Material, MaterialVersion, Page, Project, Workspace, WorkItem, WorkResult } from '@flux/contracts';
import { docUseCases } from '../../apps/server/src/docs/adapters.js';
import type { ClientResponse } from './support/http.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';
import { StreamClient } from './support/stream.js';

// Project docs and wiki (issue #112): two people plus a viewer and an outsider; immutable
// versions with author, time and reason; If-Match conflicts and idempotent retries; links and
// backlinks to work, decisions, results, messages, sketches and other docs; "Add to docs" from
// a result or decision; sanitized Markdown; events and the workspace list filter.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool, db } = createDatabase(connectionString);
after(() => pool.end());

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const get = (someone: Person, path: string) => someone.browser.request('GET', path);
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const code = (response: ClientResponse) => (response.json as { code?: string }).code;
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });

describe('project docs with immutable versions, links and backlinks', () => {
  let owner: Person;
  let partner: Person;
  let viewer: Person;
  let outsider: Person;
  let ws: Workspace;
  let lamp: Project;
  let other: Project;
  let conversation: Conversation;

  before(async () => {
    [owner, partner, viewer, outsider] = await Promise.all(['docs-owner', 'docs-partner', 'docs-viewer', 'docs-outsider'].map(person));
    ws = await workspace(owner, 'Docs space');
    for (const someone of [partner, viewer, outsider]) await addMember(owner, ws.id, someone, 'member');
    lamp = await createProject(owner, ws.id, 'Gesture lamp', 'restricted');
    other = await createProject(owner, ws.id, 'Other project', 'restricted');
    await grant(owner, lamp.id, partner, 'contributor');
    await grant(owner, lamp.id, viewer, 'viewer');
    conversation = json<Conversation>(await post(owner, `/api/v1/projects/${lamp.id}/conversations`,
      { body: 'The PIR sensor misses slow hand movements.', clientMessageId: randomUUID() }), 201);
  });

  test('a doc keeps immutable versions with author, time and reason; old citations stay', async () => {
    const created = await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'How the lamp senses gestures', body: 'We use a **PIR** sensor.' });
    const doc = json<Doc>(created, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    assert.deepEqual([doc.version, doc.state, doc.reason, doc.author.id, doc.author.name], [1, 'draft', 'Started the doc', owner.id, 'docs-owner']);
    assert.deepEqual(doc.audience, { kind: 'project', projectId: lamp.id });
    assert.equal(doc.html, '<p>We use a <strong>PIR</strong> sensor.</p>\n');

    // A message cites version 1 through the #36 material citation.
    const citing = json<{ source: { materialId: string; version: number } }>(await post(partner, `/api/v1/conversations/${conversation.id}/messages`,
      { body: 'See the sensing doc.', clientMessageId: randomUUID(), source: { materialId: doc.id, version: 1 } }), 201);
    assert.deepEqual(citing.source, { materialId: doc.id, version: 1 });

    assert.equal((await patch(partner, `/api/v1/docs/${doc.id}`, { body: 'We use a **ToF** sensor.' })).status, 428);
    const edited = json<Doc>(await patch(partner, `/api/v1/docs/${doc.id}`, { body: 'We use a **ToF** sensor.', state: 'published' }, ifMatch(1)), 200);
    assert.deepEqual([edited.version, edited.state, edited.reason, edited.author.id], [2, 'published', 'Published · Edited the text', partner.id]);
    const renamed = json<Doc>(await patch(owner, `/api/v1/docs/${doc.id}`, { title: 'Gesture sensing', reason: 'Shorter title' }, ifMatch(2)), 200);
    assert.deepEqual([renamed.version, renamed.reason, renamed.title], [3, 'Shorter title', 'Gesture sensing']);
    const same = json<Doc>(await patch(owner, `/api/v1/docs/${doc.id}`, { title: 'Gesture sensing' }, ifMatch(3)), 200);
    assert.equal(same.version, 3, 'saving without a change makes no version');

    const first = json<DocVersion>(await get(viewer, `/api/v1/docs/${doc.id}/versions/1`), 200);
    assert.deepEqual([first.title, first.body, first.state, first.author.id], ['How the lamp senses gestures', 'We use a **PIR** sensor.', 'draft', owner.id]);
    const cited = json<MaterialVersion>(await get(viewer, `/api/v1/materials/${doc.id}/versions/1`), 200);
    assert.equal(cited.body, 'We use a **PIR** sensor.', 'the citation still reads what was cited');
    const history = json<Page<DocVersionSummary>>(await get(viewer, `/api/v1/docs/${doc.id}/versions`), 200);
    assert.deepEqual(history.items.map((item) => [item.version, item.reason, item.author.name]),
      [[3, 'Shorter title', 'docs-owner'], [2, 'Published · Edited the text', 'docs-partner'], [1, 'Started the doc', 'docs-owner']]);
    assert.ok(history.items.every((item) => !Number.isNaN(Date.parse(item.createdAt))));
    assert.equal((await get(viewer, `/api/v1/docs/${doc.id}/versions/9`)).status, 404);

    // The database refuses to rewrite a version, even outside the API.
    await assert.rejects(pool.query("UPDATE project_material_versions SET body = 'rewritten' WHERE material_id = $1 AND version = 1", [doc.id]), /immutable/);
    // Docs are edited through the doc API only and are not listed as materials.
    assert.equal(code(await patch(owner, `/api/v1/materials/${doc.id}`, { clientMutationId: randomUUID(), expectedVersion: 3, body: 'x' })), 'USE_DOC_API');
    const materials = json<Page<Material>>(await get(owner, `/api/v1/projects/${lamp.id}/materials`), 200);
    assert.ok(materials.items.every((item) => item.materialId !== doc.id));
  });

  test('access follows the project: viewers read, outsiders see nothing, agents read but do not write', async () => {
    const doc = json<Doc>(await post(partner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Wiring notes', state: 'published' }), 201);
    assert.equal(json<Doc>(await get(viewer, `/api/v1/docs/${doc.id}`), 200).title, 'Wiring notes');
    assert.equal((await patch(viewer, `/api/v1/docs/${doc.id}`, { body: 'No' }, ifMatch(1))).status, 403);
    assert.equal((await post(viewer, `/api/v1/projects/${lamp.id}/docs`, { title: 'No' })).status, 403);
    const hidden = await get(outsider, `/api/v1/docs/${doc.id}`);
    const missing = await get(outsider, `/api/v1/docs/${randomUUID()}`);
    assert.deepEqual([hidden.status, code(hidden), missing.status, code(missing)], [404, 'DOC_NOT_FOUND', 404, 'DOC_NOT_FOUND']);
    assert.equal((await get(outsider, `/api/v1/docs/${doc.id}/versions`)).status, 404);
    assert.equal((await get(outsider, `/api/v1/docs/${doc.id}/versions/1`)).status, 404);
    assert.equal((await get(outsider, `/api/v1/projects/${lamp.id}/docs`)).status, 404);
    assert.equal((await patch(outsider, `/api/v1/docs/${doc.id}`, { body: 'x' }, ifMatch(1))).status, 404);
    assert.equal((await post(outsider, `/api/v1/projects/${lamp.id}/docs/preview`, { body: 'x' })).status, 404);

    const agent = json<Agent>(await post(owner, `/api/v1/workspaces/${ws.id}/agents`, { name: 'Doc reader', owner: 'workspace' }), 201);
    json(await post(owner, `/api/v1/projects/${lamp.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }), 201);
    const helper: Principal = { kind: 'agent', id: agent.id };
    assert.equal((await docUseCases(db).getDoc(helper, doc.id)).title, 'Wiring notes');
    await assert.rejects(docUseCases(db).updateDoc(helper, doc.id, { body: 'agent text' }, 1), (error: unknown) => error instanceof DomainError && error.code === 'DOC_NEEDS_PERSON');
    await assert.rejects(docUseCases(db).getDoc({ kind: 'agent', id: randomUUID() }, doc.id), (error: unknown) => error instanceof DomainError && error.code === 'DOC_NOT_FOUND');
  });

  test('concurrent edits: one wins, the other gets 409 with the latest version; retries are idempotent', async () => {
    const doc = json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Build log', body: 'Day 1' }), 201);
    const race = await Promise.all([
      patch(owner, `/api/v1/docs/${doc.id}`, { body: 'Day 1\nDay 2 (Ada)' }, ifMatch(1)),
      patch(partner, `/api/v1/docs/${doc.id}`, { body: 'Day 1\nDay 2 (Jonas)' }, ifMatch(1)),
    ]);
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
    const lost = race.find((response) => response.status === 409)!;
    const conflict = lost.json as { code: string; currentVersion: number; current: Doc };
    const winner = (race.find((response) => response.status === 200)!.json as Doc);
    assert.deepEqual([conflict.code, conflict.currentVersion, conflict.current.body], ['VERSION_CONFLICT', 2, winner.body]);
    const versions = await pool.query('SELECT count(*)::int AS n FROM project_material_versions WHERE material_id = $1', [doc.id]);
    assert.equal(versions.rows[0].n, 2, 'nothing was overwritten silently');

    const key = randomUUID();
    const change = { body: 'Day 1\nDay 2\nDay 3' };
    const firstTry = await patch(owner, `/api/v1/docs/${doc.id}`, change, { ...ifMatch(2), 'idempotency-key': key });
    const retry = await patch(owner, `/api/v1/docs/${doc.id}`, change, { ...ifMatch(2), 'idempotency-key': key });
    assert.deepEqual([firstTry.status, retry.status, retry.headers.get('idempotent-replayed'), (retry.json as Doc).version], [200, 200, 'true', 3]);
    assert.equal(retry.headers.get('etag'), '"3"');
    const createKey = randomUUID();
    const a = await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Once' }, { 'idempotency-key': createKey });
    const b = await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Once' }, { 'idempotency-key': createKey });
    assert.equal((a.json as Doc).id, (b.json as Doc).id);
    const rows = await pool.query("SELECT count(*)::int AS n FROM project_material_versions WHERE project_id = $1 AND title = 'Once'", [lamp.id]);
    assert.equal(rows.rows[0].n, 1);
  });

  test('links reach work, decisions, results, messages, sketches and docs; backlinks are visible; other projects never leak', async () => {
    const work = json<WorkItem>(await post(owner, `/api/v1/projects/${lamp.id}/work`, { title: 'Test the ToF sensor' }), 201);
    const decision = json<Decision>(await post(owner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use ToF for gestures' }), 201);
    const result = json<WorkResult>(await post(partner, `/api/v1/projects/${lamp.id}/results`, { title: 'ToF works at 0 lux', finding: 'positive' }), 201);
    const sketch = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Sensor options', scope: 'project', projectId: lamp.id }), 201);
    const privateSketch = json<{ id: string }>(await post(owner, `/api/v1/workspaces/${ws.id}/sketches`, { title: 'Secret plan', scope: 'private' }), 201);
    const message = conversation.messages[0]!;
    const target = json<Doc>(await post(partner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Sensor comparison' }), 201);
    const foreignDoc = json<Doc>(await post(owner, `/api/v1/projects/${other.id}/docs`, { title: 'Hidden elsewhere' }), 201);
    const body = [
      `Plan: [the test](flux:work/${work.id}), [rule](flux:decision/${decision.id}), [finding](flux:result/${result.id}).`,
      `From [the chat](flux:message/${message.id}), see [options](flux:sketch/${sketch.id}) and [comparison](flux:doc/${target.id}).`,
      `Not linkable: [private](flux:sketch/${privateSketch.id}), [elsewhere](flux:doc/${foreignDoc.id}), [gone](flux:work/${randomUUID()}).`,
      '`[code](flux:doc/' + target.id + ')` is only code.',
    ].join('\n\n');
    const doc = json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Sensing plan', body }), 201);

    const mentions = doc.links.filter((link) => link.role === 'mentions').map((link) => `${link.to.type}:${link.toTitle}`).sort();
    assert.deepEqual(mentions, ['decision:Use ToF for gestures', 'doc:Sensor comparison', `message:${message.body}`, 'result:ToF works at 0 lux', 'sketch:Sensor options', 'work:Test the ToF sensor']);
    assert.equal(doc.mentions.filter((item) => item.path === null).length, 3);
    assert.ok(!doc.html.includes('Secret plan') && !doc.html.includes('Hidden elsewhere'), 'nothing of other audiences is shown');
    assert.ok(doc.html.includes(`href="/projects/${lamp.id}/conversations/${conversation.id}#message-${message.id}"`));
    assert.ok(doc.html.includes(`href="/projects/${lamp.id}/docs/${target.id}" class="doc-ref" data-ref-type="doc"`));
    assert.ok(doc.html.includes('<span class="doc-ref doc-ref--missing">private</span>'));
    assert.ok(doc.html.includes(`<code>[code](flux:doc/${target.id})</code>`));

    // Backlinks: the other doc and the work objects show where they are mentioned.
    const back = json<Doc>(await get(viewer, `/api/v1/docs/${target.id}`), 200);
    assert.deepEqual(back.links.filter((link) => link.to.id === target.id).map((link) => [link.role, link.from.type, link.fromTitle]), [['mentions', 'doc', 'Sensing plan']]);
    const workView = json<WorkItem>(await get(viewer, `/api/v1/work/${work.id}`), 200);
    assert.ok(workView.links.some((link) => link.from.type === 'doc' && link.from.id === doc.id && link.fromTitle === 'Sensing plan'));
    // A work item can link to a doc as well, and the doc shows it.
    json(await post(owner, `/api/v1/projects/${lamp.id}/links`, { from: { type: 'work', id: work.id }, to: { type: 'doc', id: target.id } }), 201);
    const linkedDoc = json<Doc>(await get(owner, `/api/v1/docs/${target.id}`), 200);
    assert.ok(linkedDoc.links.some((link) => link.from.type === 'work' && link.from.id === work.id && link.role === 'related'));
    const foreignLink = await post(owner, `/api/v1/projects/${lamp.id}/links`, { from: { type: 'work', id: work.id }, to: { type: 'doc', id: foreignDoc.id } });
    assert.equal(code(foreignLink), 'LINK_TARGET_NOT_FOUND');

    // A new version rewrites the mentions: removed references stop being backlinks.
    const trimmed = json<Doc>(await patch(owner, `/api/v1/docs/${doc.id}`, { body: `Only [the test](flux:work/${work.id}).` }, ifMatch(1)), 200);
    assert.deepEqual(trimmed.links.filter((link) => link.role === 'mentions').map((link) => link.to.id), [work.id]);
    const after = json<Doc>(await get(owner, `/api/v1/docs/${target.id}`), 200);
    assert.ok(!after.links.some((link) => link.role === 'mentions' && link.from.id === doc.id));
    const v1 = json<DocVersion>(await get(owner, `/api/v1/docs/${doc.id}/versions/1`), 200);
    assert.ok(v1.body.includes(`flux:doc/${target.id}`), 'the earlier version keeps its text');
  });

  test('Markdown is sanitized on the server: scripts, handlers, javascript: and data: URLs never render', async () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(2)>',
      '<a href="javascript:alert(3)">raw</a>',
      '[click](javascript:alert(4))',
      '[click](JAVASCRIPT:alert(5))',
      '[click](java&#115;cript:alert(6))',
      '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCg3KTwvc2NyaXB0Pg==)',
      '![img](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoOCk+)',
      '<javascript:alert(9)>',
      '[ref][x]\n\n[x]: javascript:alert(10)',
      '[proto](//evil.example/path)',
      '<iframe src="https://evil.example"></iframe>',
      '<svg onload=alert(11)>',
      '[x](vbscript:msgbox(12))',
      '<style>body{display:none}</style>',
    ].join('\n\n');
    const doc = json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Hostile text', body: payloads }), 201);
    const preview = json<DocPreview>(await post(viewer, `/api/v1/projects/${lamp.id}/docs/preview`, { body: payloads }), 200);
    const version = json<DocVersion>(await get(owner, `/api/v1/docs/${doc.id}/versions/1`), 200);
    for (const html of [doc.html, preview.html, version.html]) {
      assert.doesNotMatch(html, /<(script|img|iframe|svg|style)\b/i);
      assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, 'no event handler attribute survives');
      assert.doesNotMatch(html, /<a\b[^>]*href="(javascript|data|vbscript):/i);
      assert.doesNotMatch(html, /<a\b[^>]*href="\/\//, 'no protocol-relative link');
      // Only the plain https address inside the escaped iframe text is linkified.
      assert.deepEqual((html.match(/<a\b[^>]*>/g) ?? []).map((tag) => /href="([^"]*)"/.exec(tag)?.[1]), ['https://evil.example'], 'no hostile link became a link');
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'raw HTML is shown as text');
    }
    const safe = json<DocPreview>(await post(owner, `/api/v1/projects/${lamp.id}/docs/preview`, { body: '[site](https://example.com) and **bold**\n\n| a | b |\n|---|--:|\n| 1 | 2 |' }), 200);
    assert.match(safe.html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer nofollow">site<\/a>/);
    assert.match(safe.html, /<td style="text-align:right">2<\/td>/);
    assert.equal(doc.body, payloads, 'the source is stored as written');
  });

  test('Add to docs from a result or decision keeps the source, and a newer version says what changed', async () => {
    const result = json<WorkResult>(await post(partner, `/api/v1/projects/${lamp.id}/results`, {
      title: 'The camera fails below 10 lux', finding: 'negative', evidence: '38% of gestures caught at 5 lux.\n## not a heading',
    }), 201);
    const started = json<Doc>(await post(partner, `/api/v1/projects/${lamp.id}/docs`, { title: 'What we learned', from: { type: 'result', id: result.id } }), 201);
    assert.equal(started.reason, 'Started from the result “The camera fails below 10 lux”');
    assert.match(started.body, /^## Result: The camera fails below 10 lux\n\n\*\*Negative result\*\* · recorded by docs-partner · /);
    assert.ok(started.body.includes('\\## not a heading'), 'quoted text cannot open a new section');
    assert.ok(started.body.trimEnd().endsWith(`Source: [The camera fails below 10 lux](flux:result/${result.id})`));
    assert.ok(started.links.some((link) => link.role === 'source' && link.to.type === 'result' && link.to.id === result.id));
    const resultView = json<WorkResult>(await get(viewer, `/api/v1/results/${result.id}`), 200);
    assert.ok(resultView.links.some((link) => link.from.type === 'doc' && link.from.id === started.id && link.role === 'source'), 'the result shows the doc');

    // A decision is added to the same doc, then rewritten after it is superseded.
    const rule = json<Decision>(await post(owner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use a camera', rationale: 'Richest gestures' }), 201);
    json(await post(owner, `/api/v1/decisions/${rule.id}/accept`, {}, ifMatch(1)), 200);
    const section = `/api/v1/docs/${started.id}/sections`;
    assert.equal((await post(owner, section, { from: { type: 'decision', id: rule.id } })).status, 428);
    assert.equal((await post(viewer, section, { from: { type: 'decision', id: rule.id } }, ifMatch(1))).status, 403);
    const added = json<Doc>(await post(owner, section, { from: { type: 'decision', id: rule.id } }, ifMatch(1)), 200);
    assert.deepEqual([added.version, added.reason], [2, 'Added the decision “Use a camera”']);
    assert.match(added.body, /## Decision: Use a camera\n\n\*\*Current rule\*\* · accepted by docs-owner/);
    assert.ok(added.body.startsWith(started.body.trimEnd()), 'the earlier section is untouched');
    const unchanged = json<Doc>(await post(owner, section, { from: { type: 'decision', id: rule.id } }, ifMatch(2)), 200);
    assert.equal(unchanged.version, 2, 'nothing new to add makes no version');
    assert.equal(code(await post(owner, section, { from: { type: 'decision', id: rule.id } }, ifMatch(1))), 'VERSION_CONFLICT');

    const replacement = json<Decision>(await post(owner, `/api/v1/projects/${lamp.id}/decisions`, { title: 'Use a ToF sensor', supersedes: rule.id }), 201);
    json(await post(owner, `/api/v1/decisions/${replacement.id}/accept`, {}, ifMatch(1)), 200);
    const rewritten = json<Doc>(await post(partner, section, { from: { type: 'decision', id: rule.id } }, ifMatch(2)), 200);
    assert.deepEqual([rewritten.version, rewritten.reason], [3, 'Updated the decision “Use a camera”']);
    assert.match(rewritten.body, new RegExp(`\\*\\*Earlier rule\\*\\* · replaced [^\\n]+ by \\[Use a ToF sensor\\]\\(flux:decision/${replacement.id}\\)`));
    assert.equal((rewritten.body.match(/## Decision: Use a camera/g) ?? []).length, 1, 'the section is rewritten, not duplicated');
    const earlier = json<DocVersion>(await get(viewer, `/api/v1/docs/${started.id}/versions/2`), 200);
    assert.match(earlier.body, /\*\*Current rule\*\*/, 'the past statement stays in its version');

    const elsewhere = json<WorkResult>(await post(owner, `/api/v1/projects/${other.id}/results`, { title: 'Other finding', finding: 'positive' }), 201);
    assert.equal(code(await post(owner, section, { from: { type: 'result', id: elsewhere.id } }, ifMatch(3))), 'LINK_TARGET_NOT_FOUND');
    assert.equal(code(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'x', from: { type: 'result', id: elsewhere.id } })), 'LINK_TARGET_NOT_FOUND');
  });

  test('upsertSection replaces only the cited section and keeps other text byte for byte', () => {
    const source = { type: 'result' as const, id: '11111111-1111-1111-1111-111111111111' };
    const marker = `Source: [R](flux:result/${source.id})`;
    const text = ['# Intro', '', 'Keep   spacing', '', '', '## Result: R', '', 'old', '', marker, '', '## Next', '```', '## not a heading', '```', ''].join('\n');
    const { body, replaced } = upsertSection(text, source, ['## Result: R', '', 'new', '', marker].join('\n'));
    assert.equal(replaced, true);
    assert.equal(body, ['# Intro', '', 'Keep   spacing', '', '', '## Result: R', '', 'new', '', marker, '', '## Next', '```', '## not a heading', '```', ''].join('\n'));
    assert.deepEqual(upsertSection('', source, '## A\n\nx').body, '## A\n\nx\n');
  });

  test('events carry ids only and reach project readers; the workspace list uses the visibility filter', async () => {
    const [partnerLive, outsiderLive] = await Promise.all([StreamClient.connect(partner.browser), StreamClient.connect(outsider.browser)]);
    try {
      await Promise.all([partnerLive.ready(), outsiderLive.ready()]);
      const doc = json<Doc>(await post(owner, `/api/v1/projects/${lamp.id}/docs`, { title: 'Secret sauce recipe', body: 'confidential words' }), 201);
      json(await patch(owner, `/api/v1/docs/${doc.id}`, { body: 'more confidential words' }, ifMatch(1)), 200);
      await partnerLive.until(() => partnerLive.events.find((event) => event.kind === 'project.doc_updated.v1' && event.objectId === lamp.id), 8000, 'doc event');
      const rows = await pool.query("SELECT kind, data FROM events WHERE object_id = $1 AND kind LIKE 'project.doc_%' AND data->>'docId' = $2 ORDER BY seq", [lamp.id, doc.id]);
      assert.deepEqual(rows.rows.map((row) => [row.kind, row.data]), [
        ['project.doc_created.v1', { docId: doc.id, version: 1 }], ['project.doc_updated.v1', { docId: doc.id, version: 2 }],
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(outsiderLive.events.some((event) => event.objectId === lamp.id), false);
    } finally { await Promise.all([partnerLive.close(), outsiderLive.close()]); }

    json(await post(owner, `/api/v1/projects/${other.id}/docs`, { title: 'Only the owner project' }), 201);
    const mine = json<Page<DocSummary>>(await get(owner, `/api/v1/workspaces/${ws.id}/docs?limit=100`), 200);
    assert.ok(mine.items.some((item) => item.projectId === other.id));
    const partners = json<Page<DocSummary>>(await get(partner, `/api/v1/workspaces/${ws.id}/docs?limit=100`), 200);
    assert.ok(partners.items.length > 0 && partners.items.every((item) => item.projectId === lamp.id), 'only readable projects');
    assert.equal(partners.total, partners.items.length);
    assert.ok(partners.items.every((item) => item.projectName === 'Gesture lamp' && item.updatedBy.name));
    assert.equal(json<Page<DocSummary>>(await get(outsider, `/api/v1/workspaces/${ws.id}/docs`), 200).total, 0);
    const list = json<Page<DocSummary>>(await get(viewer, `/api/v1/projects/${lamp.id}/docs?limit=100`), 200);
    const sorted = [...list.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    assert.deepEqual(list.items.map((item) => item.id), sorted.map((item) => item.id), 'most recently changed first');

    // Losing access hides everything, including the workspace list.
    const grants = json<{ id: string; principal: { id: string } }[]>(await get(owner, `/api/v1/projects/${lamp.id}/grants`), 200);
    expectStatus(await owner.browser.request('DELETE', `/api/v1/projects/${lamp.id}/grants/${grants.find((item) => item.principal.id === partner.id)!.id}`), 204);
    assert.equal(json<Page<DocSummary>>(await get(partner, `/api/v1/workspaces/${ws.id}/docs`), 200).total, 0);
    assert.equal((await get(partner, `/api/v1/docs/${list.items[0]!.id}`)).status, 404);
  });
});
