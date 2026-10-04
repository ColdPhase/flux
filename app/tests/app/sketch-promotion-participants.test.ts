import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Dm, ProjectGrant, ProjectPerson, PromotedSketch, Sketch, SketchPromotionPreview, Workspace } from '@flux/contracts';
import { createDatabase } from '@flux/db';
import { addMember, expectStatus, person, project, workspace, type Person } from './support/people.js';

// Promoting a DM sketch into a new project gives the DM's other people access only when the
// person chooses it (#188, AC-3). `participants: 'none'` previews and creates a project that only
// the promoter and the workspace's owners and admins can open; `grant` (and no value, the #96
// default) gives the other participants contributor access. The token names the readers, so a
// promotion that does not match the preview's choice changes nothing.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(connectionString);
after(() => pool.end());

const preview = (actor: Person, sketchId: string, query: Record<string, string>) =>
  actor.browser.request('GET', `/api/v1/sketches/${sketchId}/promotion?${new URLSearchParams(query)}`);
const promote = (actor: Person, sketchId: string, body: unknown, headers: Record<string, string> = {}) =>
  actor.browser.request('POST', `/api/v1/sketches/${sketchId}/promotion`, { body, headers });

describe('DM sketch promotion with an explicit participant choice', () => {
  let olga: Person; // owner, outside the DM
  let jo: Person; // admin, promotes
  let kai: Person; // member, Jo's DM partner
  let mo: Person; // member outside the DM
  let ws: Workspace;
  let dm: Dm;

  async function dmSketch(title: string) {
    return expectStatus(await jo.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`, { body: { title, scope: 'dm', dmId: dm.id } }), 201, 'sketch') as Sketch;
  }

  before(async () => {
    [olga, jo, kai, mo] = await Promise.all(['prom-olga', 'prom-jo', 'prom-kai', 'prom-mo'].map(person));
    ws = await workspace(olga, 'Lamp makers');
    await addMember(olga, ws.id, jo, 'admin');
    await addMember(olga, ws.id, kai, 'member');
    await addMember(olga, ws.id, mo, 'member');
    const opened = await jo.browser.request('POST', `/api/v1/workspaces/${ws.id}/dms`, { body: { participantIds: [kai.id] } });
    assert.ok(opened.status === 200 || opened.status === 201, opened.text);
    dm = opened.json as Dm;
    expectStatus(await kai.browser.request('POST', `/api/v1/dms/${dm.id}/messages`, { body: { body: 'A lamp you dim with a wave?', clientMessageId: randomUUID() } }), 201);
  });

  test('without the choice, a new project is the promoter’s and its managers’ only', async () => {
    const sketch = await dmSketch('Gesture lamp');
    const seen = expectStatus(await preview(jo, sketch.id, { target: 'new', participants: 'none' }), 200, 'preview') as SketchPromotionPreview;
    assert.deepEqual(new Set(seen.audience.map((p) => `${p.id}:${p.reason}`)), new Set([`${jo.id}:participant`, `${olga.id}:manager`]));
    assert.deepEqual(seen.leftOut.map((p) => p.id), [kai.id], 'Kai is named as left out');

    // The default (#96) and `grant` preview Kai as a reader, under a different token.
    const granted = expectStatus(await preview(jo, sketch.id, { target: 'new', participants: 'grant' }), 200) as SketchPromotionPreview;
    const byDefault = expectStatus(await preview(jo, sketch.id, { target: 'new' }), 200) as SketchPromotionPreview;
    assert.ok(granted.audience.some((p) => p.id === kai.id && p.reason === 'participant'));
    assert.deepEqual(granted.leftOut, []);
    assert.equal(byDefault.token, granted.token);
    assert.notEqual(seen.token, granted.token, 'the token names the readers');

    // A promotion whose choice differs from the preview it sends commits nothing.
    const mismatch = await promote(jo, sketch.id, { target: { kind: 'new', name: 'Gesture lamp' }, token: seen.token, participants: 'grant' });
    expectStatus(mismatch, 409, 'choice differs from the preview');
    assert.equal((mismatch.json as { code: string }).code, 'PROMOTION_CHANGED');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND name = 'Gesture lamp'", [ws.id])).rows[0].n, 0);

    const key = randomUUID();
    const done = expectStatus(await promote(jo, sketch.id, { target: { kind: 'new', name: 'Gesture lamp' }, token: seen.token, participants: 'none' }, { 'idempotency-key': key }), 201, 'promote') as PromotedSketch;
    const people = expectStatus(await jo.browser.request('GET', `/api/v1/projects/${done.project.id}/people`), 200) as ProjectPerson[];
    assert.deepEqual(new Set(people.map((p) => p.id)), new Set(seen.audience.map((p) => p.id)), 'the preview was exact');
    const grants = expectStatus(await jo.browser.request('GET', `/api/v1/projects/${done.project.id}/grants`), 200) as ProjectGrant[];
    assert.deepEqual(grants, [], 'nobody was granted');
    expectStatus(await kai.browser.request('GET', `/api/v1/projects/${done.project.id}`), 404, 'Kai cannot see the project');
    expectStatus(await kai.browser.request('GET', `/api/v1/sketches/${done.sketch.id}`), 404, 'nor the copy');
    expectStatus(await mo.browser.request('GET', `/api/v1/projects/${done.project.id}`), 404);
    // A retry with the same key replays the same copy.
    const again = await promote(jo, sketch.id, { target: { kind: 'new', name: 'Gesture lamp' }, token: seen.token, participants: 'none' }, { 'idempotency-key': key });
    expectStatus(again, 201, 'retry');
    assert.equal((again.json as PromotedSketch).sketch.id, done.sketch.id);
  });

  test('with the choice, the other participants become contributors and nobody else', async () => {
    const sketch = await dmSketch('Desk sensor');
    const seen = expectStatus(await preview(jo, sketch.id, { target: 'new', participants: 'grant' }), 200) as SketchPromotionPreview;
    const done = expectStatus(await promote(jo, sketch.id, { target: { kind: 'new', name: 'Desk sensor' }, token: seen.token, participants: 'grant' }), 201) as PromotedSketch;
    const grants = expectStatus(await jo.browser.request('GET', `/api/v1/projects/${done.project.id}/grants`), 200) as ProjectGrant[];
    assert.deepEqual(grants.map((g) => [g.principal.id, g.role]), [[kai.id, 'contributor']]);
    expectStatus(await kai.browser.request('GET', `/api/v1/sketches/${done.sketch.id}`), 200, 'Kai opens the copy');
    expectStatus(await mo.browser.request('GET', `/api/v1/projects/${done.project.id}`), 404, 'a member outside the DM does not');
  });

  test('an existing project’s audience is the same either way, and unknown choices are refused', async () => {
    const sketch = await dmSketch('Bench notes');
    const bench = await project(olga, ws.id, 'Bench', 'restricted');
    const none = expectStatus(await preview(jo, sketch.id, { projectId: bench.id, participants: 'none' }), 200) as SketchPromotionPreview;
    const grant = expectStatus(await preview(jo, sketch.id, { projectId: bench.id, participants: 'grant' }), 200) as SketchPromotionPreview;
    assert.equal(none.token, grant.token);
    assert.deepEqual(none.leftOut.map((p) => p.id), [kai.id]);
    expectStatus(await preview(jo, sketch.id, { target: 'new', participants: 'everyone' }), 400, 'unknown query value');
    const seen = expectStatus(await preview(jo, sketch.id, { target: 'new' }), 200) as SketchPromotionPreview;
    expectStatus(await promote(jo, sketch.id, { target: { kind: 'new', name: 'Bench notes' }, token: seen.token, participants: 'all' }), 400, 'unknown body value');
    // Even asked to, a promotion into an existing project grants nobody: a grant there could lift a deny.
    const copied = expectStatus(await promote(jo, sketch.id, { target: { kind: 'existing', projectId: bench.id }, token: grant.token, participants: 'grant' }), 201) as PromotedSketch;
    assert.equal(copied.project.id, bench.id);
    const benchGrants = expectStatus(await olga.browser.request('GET', `/api/v1/projects/${bench.id}/grants`), 200) as ProjectGrant[];
    assert.ok(!benchGrants.some((g) => g.principal.id === kai.id), 'no grant for Kai');
  });
});
