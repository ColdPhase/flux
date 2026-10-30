import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { convertDecisionSections, placeDecisionReference, upsertSection } from '@flux/core';
import { projectWorkReferenceRowsPath, type Decision, type Doc, type DocVersionSummary, type Page, type Project, type WorkReferenceRows, type WorkResult, type Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import type { ClientResponse } from './support/http.js';
import { createSealed, fixtureBearer, passphrase } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// F-034 (#763 E1, founder decision 2026-10-30): a decision in the Wiki is one live card with its short reason, a
// reference line in the page, never copied text. "Add to docs" inserts the reference once; the card reads the decision
// as it is now, so accepting or replacing it adds no version; a proposed decision stays out; the copied sections of
// earlier pages are converted once by a conservative, idempotent migration, in plain and encrypted workspaces.

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const patch = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('PATCH', path, { body, headers });
const get = (someone: Person, path: string) => someone.browser.request('GET', path);
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const code = (response: ClientResponse) => (response.json as { code?: string }).code;
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const ref = (title: string, id: string) => `[${title}](flux:decision/${id})`;

/** The F-034 migration on the API (its keys open encrypted workspaces), for the named docs only. */
async function convert(someone: Person, docIds: string[]) {
  return json<{ converted: number; unchanged: number; skipped: number }>(await post(someone, '/api/v1/test/doc-decision-cards', { docIds }, fixtureBearer()), 200, 'conversion');
}

/** The section "Add to docs" wrote before F-034, byte for byte as `composeSection` made it. */
function legacySection(decision: Decision, status: string, rationale = decision.rationale) {
  return [`## Decision: ${decision.title}`, '', status, '', ...(rationale.trim() ? [rationale, ''] : []), `Source: [${decision.title}](flux:decision/${decision.id})`].join('\n');
}

describe('F-034: decisions in the Wiki are live cards', () => {
  let ada: Person;
  let jonas: Person;
  let viewer: Person;
  let ws: Workspace;
  let garden: Project;

  const decide = async (title: string, rationale: string, accept = true, supersedes?: string) => {
    const made = json<Decision>(await post(ada, `/api/v1/projects/${garden.id}/decisions`, { title, rationale, ...(supersedes ? { supersedes } : {}) }), 201);
    return accept ? json<Decision>(await post(ada, `/api/v1/decisions/${made.id}/accept`, {}, ifMatch(made.version)), 200) : made;
  };
  const rows = async (ids: string[]) => json<WorkReferenceRows>(await get(viewer,
    `${projectWorkReferenceRowsPath(garden.id)}?objects=${encodeURIComponent(ids.map((id) => `decision:${id}`).join(','))}`), 200).items;

  before(async () => {
    [ada, jonas, viewer] = await Promise.all(['cards-ada', 'cards-jonas', 'cards-viewer'].map(person));
    ws = await workspace(ada, 'Cards space');
    for (const someone of [jonas, viewer]) await addMember(ada, ws.id, someone, 'member');
    garden = await createProject(ada, ws.id, 'Garden sensors', 'restricted');
    await grant(ada, garden.id, jonas, 'contributor');
    await grant(ada, garden.id, viewer, 'viewer');
  });

  test('Add to docs inserts one reference line, once; the page gets no copied text and no heading', async () => {
    const rule = await decide('Measure soil moisture first', 'Moisture is what kills seedlings. Frost comes later in the season.');
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'How the sensors work', body: '# Sensors\n\nSix probes report to the shed.' }), 201);
    const added = json<Doc>(await post(jonas, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: rule.id } }, ifMatch(1)), 200);
    assert.deepEqual([added.version, added.reason, added.author.id], [2, `Added the decision “${rule.title}”`, jonas.id]);
    assert.equal(added.body, `# Sensors\n\nSix probes report to the shed.\n\n${ref(rule.title, rule.id)}\n`);
    assert.ok(!/Decision:|Source:|Moisture is what kills/.test(added.body), 'no heading, no Source line and no copied rationale');
    assert.match(added.html, new RegExp(`<p><a href="[^"]+" class="doc-ref" data-ref-type="decision" data-ref-id="${rule.id}">Measure soil moisture first</a></p>`), 'a reference standing alone: the reader draws it as the card');
    assert.ok(added.links.some((link) => link.role === 'source' && link.to.type === 'decision' && link.to.id === rule.id), 'the source link is kept');
    const again = json<Doc>(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: rule.id } }, ifMatch(2)), 200);
    assert.equal(again.version, 2, 'a page that already holds the card stays as it is');
    // A new page started from a decision is the card alone.
    const started = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Decisions and why', from: { type: 'decision', id: rule.id } }), 201);
    assert.deepEqual([started.body, started.reason], [`${ref(rule.title, rule.id)}\n`, `Started from the decision “${rule.title}”`]);
    // Results keep their sections.
    const result = json<WorkResult>(await post(ada, `/api/v1/projects/${garden.id}/results`, { title: 'Probes corrode in three weeks', finding: 'negative', evidence: 'Readings drift.' }), 201);
    const withResult = json<Doc>(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'result', id: result.id } }, ifMatch(2)), 200);
    assert.match(withResult.body, /## Result: Probes corrode in three weeks\n\n\*\*Negative result\*\*/);
  });

  test('the card is live: accepting or replacing a decision changes no page and adds no version', async () => {
    const rule = await decide('Water at dawn', 'Less evaporation in the morning. Also quieter.');
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Watering', body: 'Notes.' }), 201);
    const added = json<Doc>(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: rule.id } }, ifMatch(1)), 200);
    const [before] = await rows([rule.id]);
    assert.deepEqual(before && before.kind === 'decision' ? [before.status, before.reason, before.title] : null, ['accepted', 'Less evaporation in the morning.', 'Water at dawn'],
      'the card reads the state and the first sentence of the rationale');
    const replacement = await decide('Water at dusk', 'The pump is free in the evening.', true, rule.id);
    const after = json<Doc>(await get(viewer, `/api/v1/docs/${doc.id}`), 200);
    assert.deepEqual([after.version, after.body], [added.version, added.body], 'replacing the decision rewrote nothing');
    const history = json<Page<DocVersionSummary>>(await get(viewer, `/api/v1/docs/${doc.id}/versions`), 200);
    assert.deepEqual(history.items.map((item) => item.reason), [`Added the decision “${rule.title}”`, 'Started the doc'], 'history keeps only what people did');
    const [now] = await rows([rule.id]);
    assert.deepEqual(now && now.kind === 'decision' ? [now.status, now.supersededBy] : null, ['superseded', replacement.id], 'the same reference now reads as replaced');
  });

  test('a proposed decision stays out of the Wiki until it is accepted', async () => {
    const proposal = await decide('Add frost warnings', 'Night frost killed two beds last May.', false);
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Frost', body: 'Later.' }), 201);
    const refused = await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: proposal.id } }, ifMatch(1));
    assert.deepEqual([refused.status, code(refused)], [422, 'DECISION_NOT_ACCEPTED']);
    const start = await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Frost rules', from: { type: 'decision', id: proposal.id } });
    assert.deepEqual([start.status, code(start)], [422, 'DECISION_NOT_ACCEPTED']);
    assert.equal(json<Doc>(await get(ada, `/api/v1/docs/${doc.id}`), 200).version, 1, 'nothing was written');
    const accepted = json<Decision>(await post(ada, `/api/v1/decisions/${proposal.id}/accept`, {}, ifMatch(proposal.version)), 200);
    const added = json<Doc>(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: accepted.id } }, ifMatch(1)), 200);
    assert.ok(added.body.endsWith(`${ref(accepted.title, accepted.id)}\n`));
  });

  test('the migration converts copied sections conservatively, keeps human text, and runs once', async () => {
    const kept = await decide('Six probes, one gateway', 'One gateway in the shed reaches every bed.\n## not a heading');
    const replaced = await decide('Old probe model', 'Cheap.');
    const newer = await decide('Capacitive probes', 'They do not corrode.', true, replaced.id);
    const edited = await decide('Readings every ten minutes', 'Enough for watering.');
    const bare = await decide('No rationale', '');
    const result = json<WorkResult>(await post(ada, `/api/v1/projects/${garden.id}/results`, { title: 'Range is 180 m', finding: 'positive', evidence: 'Measured.' }), 201);
    const resultSection = `## Result: Range is 180 m\n\n**Positive result** · recorded by cards-ada · Oct 30, 2026\n\nMeasured.\n\nSource: [Range is 180 m](flux:result/${result.id})`;
    const quoted = '\\## not a heading';
    const body = [
      '# How the sensors work', '', 'Intro   kept  as written.', '',
      legacySection(kept, '**Current rule** · accepted by cards-ada · Oct 29, 2026', `One gateway in the shed reaches every bed.\n${quoted}`), '',
      'A note a person wrote under the section.', '',
      '## Parts', '', 'A table would be here.', '',
      legacySection(replaced, `**Earlier rule** · replaced Oct 30, 2026 by [${newer.title}](flux:decision/${newer.id})`), '',
      legacySection(edited, '**Current rule** · accepted by cards-ada · Oct 29, 2026', 'Enough for watering, and Jonas added this.'), '',
      legacySection(bare, '**Current rule** · accepted by cards-ada · Oct 29, 2026'), '',
      resultSection, '',
      '```', legacySection(kept, '**Current rule** · accepted by cards-ada · Oct 29, 2026', `One gateway in the shed reaches every bed.\n${quoted}`), '```', '',
    ].join('\n');
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Legacy page', body: 'x' }), 201);
    // As before F-034: Ada added the decisions; then Jonas edited the page.
    json<Doc>(await patch(ada, `/api/v1/docs/${doc.id}`, { body, reason: `Added the decision “${bare.title}”` }, ifMatch(1)), 200);
    const before = json<Doc>(await patch(jonas, `/api/v1/docs/${doc.id}`, { body: `${body}Jonas's closing line.\n` }, ifMatch(2)), 200);

    assert.deepEqual(await convert(ada, [doc.id]), { converted: 1, unchanged: 0, skipped: 0 });
    const after = json<Doc>(await get(viewer, `/api/v1/docs/${doc.id}`), 200);
    const expected = [
      '# How the sensors work', '', 'Intro   kept  as written.', '',
      ref(kept.title, kept.id), '',
      'A note a person wrote under the section.', '',
      '## Parts', '', 'A table would be here.', '',
      ref(replaced.title, replaced.id), '',
      legacySection(edited, '**Current rule** · accepted by cards-ada · Oct 29, 2026', 'Enough for watering, and Jonas added this.'), '',
      ref(bare.title, bare.id), '',
      resultSection, '',
      '```', legacySection(kept, '**Current rule** · accepted by cards-ada · Oct 29, 2026', `One gateway in the shed reaches every bed.\n${quoted}`), '```',
      "Jonas's closing line.", '',
    ].join('\n');
    assert.equal(after.body, expected, 'only unedited copied sections became cards; everything else is byte for byte');
    assert.deepEqual([after.version, after.reason, after.author.id], [4, 'Turned 3 copied decisions into live cards', ada.id], 'one version, by the person who added the decisions');
    const earlier = json<{ body: string }>(await get(viewer, `/api/v1/docs/${doc.id}/versions/3`), 200);
    assert.equal(earlier.body, before.body, 'the copied text stays in the version before');
    const recorded = (await pool.query('SELECT from_version, to_version, converted, kept FROM doc_decision_card_migrations WHERE doc_id = $1', [doc.id])).rows;
    assert.deepEqual(recorded, [{ from_version: 3, to_version: 4, converted: 3, kept: 1 }], 'recorded for reversal');
    const headings = [...after.html.matchAll(/<h[1-3]>([^<]*)<\/h[1-3]>/g)].map((match) => match[1]);
    assert.deepEqual(headings, ['How the sensors work', 'Parts', 'Decision: Readings every ten minutes', 'Result: Range is 180 m'], 'the outline holds the page’s own headings');

    // Idempotent: a second pass, even with its record removed, makes no version.
    assert.deepEqual(await convert(ada, [doc.id]), { converted: 0, unchanged: 1, skipped: 0 });
    await pool.query('DELETE FROM doc_decision_card_migrations WHERE doc_id = $1', [doc.id]);
    assert.deepEqual(await convert(ada, [doc.id]), { converted: 0, unchanged: 1, skipped: 0 });
    assert.equal(json<Doc>(await get(viewer, `/api/v1/docs/${doc.id}`), 200).version, 4);
    assert.deepEqual((await pool.query('SELECT to_version, converted, kept FROM doc_decision_card_migrations WHERE doc_id = $1', [doc.id])).rows, [{ to_version: null, converted: 0, kept: 1 }]);

    // A page without copied decisions is recorded and left alone.
    const plain = json<Doc>(await post(ada, `/api/v1/projects/${garden.id}/docs`, { title: 'Plain', body: '## Decision: just a heading\n\nWritten by hand.' }), 201);
    assert.deepEqual(await convert(ada, [plain.id]), { converted: 0, unchanged: 1, skipped: 0 });
    assert.equal(json<Doc>(await get(ada, `/api/v1/docs/${plain.id}`), 200).version, 1);
  });

  test('live co-editing: unsaved shared typing defers the conversion; a clean shared head is rebound to the new version', async () => {
    const rule = await decide('Gateway in the shed', 'Power is there.');
    const page = (title: string) => post(ada, `/api/v1/projects/${garden.id}/docs`, { title, body: `Intro.\n\n${legacySection(rule, '**Current rule** · accepted by cards-ada · Oct 30, 2026')}\n` });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const head = (doc: Doc, body: string, sequence: number) => pool.query(`INSERT INTO doc_live_heads (doc_id,workspace_id,project_id,generation,sequence,body,hash,saved_version,saved_sequence,codec_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL)`, [doc.id, doc.workspaceId, doc.projectId, randomUUID(), sequence, body, hash(body), doc.version]);
    const dirty = json<Doc>(await page('Typing now'), 201);
    await head(dirty, `${dirty.body}Someone is typing`, 1);
    assert.deepEqual(await convert(ada, [dirty.id]), { converted: 0, unchanged: 0, skipped: 1 }, 'unsaved shared text is never overwritten');
    assert.equal(json<Doc>(await get(ada, `/api/v1/docs/${dirty.id}`), 200).version, 1);
    assert.equal((await pool.query('SELECT 1 FROM doc_decision_card_migrations WHERE doc_id = $1', [dirty.id])).rowCount, 0, 'not recorded, so a later pass tries again');
    const clean = json<Doc>(await page('Open, not typing'), 201);
    await head(clean, clean.body, 0);
    assert.deepEqual(await convert(ada, [clean.id]), { converted: 1, unchanged: 0, skipped: 0 });
    const rebound = (await pool.query('SELECT body, saved_version FROM doc_live_heads WHERE doc_id = $1', [clean.id])).rows[0];
    assert.deepEqual(rebound, { body: `Intro.\n\n${ref(rule.title, rule.id)}\n`, saved_version: 2 }, 'the shared copy continues from the converted version');
  });

  test('the conversion text rules: other projects’ decisions and odd shapes are kept; the output has nothing left', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const section = ['## Decision: A', '', '**Current rule** · accepted by X · Oct 1, 2026', '', 'Why.', '', `Source: [A](flux:decision/${id})`].join('\n');
    assert.deepEqual(convertDecisionSections(section, new Map()), { body: section, converted: [], kept: 1 }, 'a decision outside the project is kept');
    const map = new Map([[id, { title: 'A', rationale: 'Why.' }]]);
    const once = convertDecisionSections(`${section}\n`, map);
    assert.deepEqual(once, { body: `[A](flux:decision/${id})\n`, converted: [id], kept: 0 });
    assert.deepEqual(convertDecisionSections(once.body, map), { body: once.body, converted: [], kept: 0 }, 'idempotent');
    const extraLine = section.replace('**Current rule**', 'Jonas: we agreed.\n\n**Current rule**');
    assert.equal(convertDecisionSections(extraLine, map).kept, 1, 'a line a person put into the section keeps it');
    assert.deepEqual(placeDecisionReference(once.body, id, 'A'), { body: once.body, replaced: false });
    // A result's section rewritten later keeps the cards after it (they are not part of the section).
    const result = { type: 'result' as const, id: '22222222-2222-4222-8222-222222222222' };
    const resultText = ['## Result: R', '', 'Old.', '', `Source: [R](flux:result/${result.id})`, '', `[A](flux:decision/${id})`, '', 'Tail.', ''].join('\n');
    assert.equal(upsertSection(resultText, result, ['## Result: R', '', 'New.', '', `Source: [R](flux:result/${result.id})`].join('\n')).body,
      ['## Result: R', '', 'New.', '', `Source: [R](flux:result/${result.id})`, '', `[A](flux:decision/${id})`, '', 'Tail.', ''].join('\n'));
    assert.deepEqual(placeDecisionReference(section, id, 'A'), { body: `[A](flux:decision/${id})\n`, replaced: true }, 'Add to docs turns its own old section into the card');
  });

  test('an encrypted workspace: Add to docs and the migration work through its seal', async () => {
    const sealed = await createSealed(ada, 'Sealed garden', passphrase());
    const project = json<Project>(await post(ada, `/api/v1/workspaces/${sealed.workspace.id}/projects`, { name: 'Sealed sensors', visibility: 'workspace' }), 201);
    const rule = json<Decision>(await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: 'Sealed rule', rationale: 'Sealed reason. More.' }), 201);
    json(await post(ada, `/api/v1/decisions/${rule.id}/accept`, {}, ifMatch(rule.version)), 200);
    const accepted = json<Decision>(await get(ada, `/api/v1/decisions/${rule.id}`), 200);
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${project.id}/docs`, { title: 'Sealed page', body: `Intro.\n\n${legacySection(accepted, '**Current rule** · accepted by cards-ada · Oct 30, 2026')}\n` }), 201);
    assert.deepEqual(await convert(ada, [doc.id]), { converted: 1, unchanged: 0, skipped: 0 });
    const after = json<Doc>(await get(ada, `/api/v1/docs/${doc.id}`), 200);
    assert.equal(after.body, `Intro.\n\n${ref('Sealed rule', rule.id)}\n`);
    const stored = (await pool.query('SELECT flux_is_sealed(body) AS sealed FROM project_material_versions WHERE material_id = $1 AND version = 2', [doc.id])).rows[0];
    assert.deepEqual(stored, { sealed: true }, 'the new version is sealed like any other');
    const rowsRead = json<WorkReferenceRows>(await get(ada, `${projectWorkReferenceRowsPath(project.id)}?objects=${encodeURIComponent(`decision:${rule.id}`)}`), 200).items;
    assert.equal(rowsRead[0]?.kind === 'decision' ? rowsRead[0].reason : null, 'Sealed reason.', 'the card reason opens through the seal');
    const proposal = json<Decision>(await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: 'Sealed proposal', rationale: 'Not yet.' }), 201);
    assert.equal(code(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: proposal.id } }, ifMatch(2))), 'DECISION_NOT_ACCEPTED');
  });
});
