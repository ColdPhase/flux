import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { placeDecisionReference, upsertSection } from '@flux/core';
import { projectWorkReferenceRowsPath, type Decision, type Doc, type DocVersionSummary, type Page, type Project, type WorkReferenceRows, type WorkResult, type Workspace } from '@flux/contracts';
import { pool } from './support/db.js';
import type { ClientResponse } from './support/http.js';
import { createSealed, passphrase } from './support/encryption.js';
import { addMember, expectStatus, grant, person, project as createProject, workspace, type Person } from './support/people.js';

// F-034 (#763 E1, founder decision 2026-10-30): a decision in the Wiki is one live card with its short reason, a
// reference line in the page, never copied text. "Add to docs" inserts the reference once; the card reads the decision
// as it is now, so accepting or replacing it adds no version; a proposed decision stays out. Nothing is converted:
// Flux is pre-release with no installations or data (founder, 2026-10-31).

const post = (someone: Person, path: string, body: unknown, headers?: Record<string, string>) => someone.browser.request('POST', path, { body, headers });
const get = (someone: Person, path: string) => someone.browser.request('GET', path);
const json = <T>(response: ClientResponse, status: number, label?: string) => expectStatus(response, status, label) as T;
const code = (response: ClientResponse) => (response.json as { code?: string }).code;
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` });
const ref = (title: string, id: string) => `[${title}](flux:decision/${id})`;

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
    assert.deepEqual(history.items.map((item) => item.reason), [`Added the decision “${rule.title}”`, 'Started the page'], 'history keeps only what people did');
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

  test('the text rules: one card line, never twice, and a result rewrite keeps the cards after it', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const card = `[A](flux:decision/${id})`;
    // The reference stands alone after a blank line, so the reader shows it as the card.
    assert.deepEqual(placeDecisionReference('Intro.\nMore.', id, 'A'), { body: `Intro.\nMore.\n\n${card}\n`, replaced: false });
    assert.deepEqual(placeDecisionReference('', id, 'A'), { body: `${card}\n`, replaced: false });
    const once = placeDecisionReference('Intro.', id, 'A').body;
    assert.equal(placeDecisionReference(once, id, 'A').body, once, 'a page that already has the card stays as it is');
    // An inline mention or a fenced example is not the card, so the card is still added.
    const inline = `We chose [A](flux:decision/${id}) last week.`;
    assert.equal(placeDecisionReference(inline, id, 'A').body, `${inline}\n\n${card}\n`);
    const fenced = ['```', card, '```'].join('\n');
    assert.equal(placeDecisionReference(fenced, id, 'A').body, `${fenced}\n\n${card}\n`);
    assert.equal(placeDecisionReference('x', id, 'A [draft] *v2*').body, `x\n\n[A \\[draft\\] \\*v2\\*](flux:decision/${id})\n`, 'the title is escaped');
    // CW-9: under a chosen heading, the card closes that heading's section, before the next heading of its level.
    const page = ['Intro.', '', '## Pickup', '', 'Codes.', '', '### Detail', '', 'More.', '', '## Still open', '', 'Lockers?', ''].join('\n');
    assert.equal(placeDecisionReference(page, id, 'A', '## Pickup').body,
      ['Intro.', '', '## Pickup', '', 'Codes.', '', '### Detail', '', 'More.', '', card, '', '## Still open', '', 'Lockers?', ''].join('\n'));
    assert.equal(placeDecisionReference(page, id, 'A', '## Still open').body, `${page.trimEnd()}\n\n${card}\n`);
    assert.equal(placeDecisionReference(page, id, 'A', '## Gone').body, `${page.trimEnd()}\n\n${card}\n`, 'a heading the page no longer has: the end');
    // A result's section rewritten later keeps the cards after it (they are not part of the section).
    const result = { type: 'result' as const, id: '22222222-2222-4222-8222-222222222222' };
    const resultText = ['## Result: R', '', 'Old.', '', `Source: [R](flux:result/${result.id})`, '', card, '', 'Tail.', ''].join('\n');
    assert.equal(upsertSection(resultText, result, ['## Result: R', '', 'New.', '', `Source: [R](flux:result/${result.id})`].join('\n')).body,
      ['## Result: R', '', 'New.', '', `Source: [R](flux:result/${result.id})`, '', card, '', 'Tail.', ''].join('\n'));
  });

  test('an encrypted workspace: Add to docs and the card reason work through its seal', async () => {
    const sealed = await createSealed(ada, 'Sealed garden', passphrase());
    const project = json<Project>(await post(ada, `/api/v1/workspaces/${sealed.workspace.id}/projects`, { name: 'Sealed sensors', visibility: 'workspace' }), 201);
    const rule = json<Decision>(await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: 'Sealed rule', rationale: 'Sealed reason. More.' }), 201);
    json(await post(ada, `/api/v1/decisions/${rule.id}/accept`, {}, ifMatch(rule.version)), 200);
    const doc = json<Doc>(await post(ada, `/api/v1/projects/${project.id}/docs`, { title: 'Sealed page', body: 'Intro.' }), 201);
    const added = json<Doc>(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: rule.id } }, ifMatch(1)), 200);
    assert.equal(added.body, `Intro.\n\n${ref('Sealed rule', rule.id)}\n`);
    const stored = (await pool.query('SELECT flux_is_sealed(body) AS sealed FROM project_material_versions WHERE material_id = $1 AND version = 2', [doc.id])).rows[0];
    assert.deepEqual(stored, { sealed: true }, 'the new version is sealed like any other');
    const rowsRead = json<WorkReferenceRows>(await get(ada, `${projectWorkReferenceRowsPath(project.id)}?objects=${encodeURIComponent(`decision:${rule.id}`)}`), 200).items;
    assert.equal(rowsRead[0]?.kind === 'decision' ? rowsRead[0].reason : null, 'Sealed reason.', 'the card reason opens through the seal');
    const proposal = json<Decision>(await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: 'Sealed proposal', rationale: 'Not yet.' }), 201);
    assert.equal(code(await post(ada, `/api/v1/docs/${doc.id}/sections`, { from: { type: 'decision', id: proposal.id } }, ifMatch(2))), 'DECISION_NOT_ACCEPTED');
  });
});
