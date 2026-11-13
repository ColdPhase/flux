import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { citeMark, docHeadings, type AssistantSourceRef } from '@flux/contracts';
import {
  agentHit, buildBrief, CITE_LINE, fluxMarks, parseOutput, resolveCites, resultCites, sourcesShown,
  type BriefInput, type CitedObject, type PersonalRunPorts, type RunRecord, type SearchRow,
} from '@flux/core';
import { markdownRenderer } from '../../apps/server/src/docs/markdown.js';

// The Wiki as the space's knowledge base (C-62, #1381), with no database: the headings a page's sections are cited by, the marks an answer carries,
// how they are resolved and numbered, and the lines of the brief. The persisted path is app/tests/app/wiki-knowledge.test.ts.

const DOC = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c10';
const DOC2 = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c11';
const TASK = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c12';
const DECISION = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c13';
const MESSAGE = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c14';
const SPACE = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c01';
const OTHER_SPACE = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c02';
const CONVERSATION = '0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1c03';

describe('the headings a Wiki page is cited by', () => {
  test('levels 1 to 3 in order, as the page\'s Contents numbers them: without fenced code, closing hashes, marks, empty ones and deeper levels', () => {
    const body = ['# Barrel', 'intro', '## Install ##', '```sh', '# not a heading', '```', '### **Wire** the `camera`', '#### too deep', '#', '## [Link text](https://example.com)',
      '~~~', '## fenced too', '~~~', '    ## indented code is not read here but a space or two is', '  ## Two spaces', 'Setext', '======'].join('\n');
    assert.deepEqual(docHeadings(body), ['Barrel', 'Install', 'Wire the camera', 'Link text', 'Two spaces', 'Setext']);
  });
  test('a long page is read once and a long heading is cut; at most 999 are numbered', () => {
    assert.equal(docHeadings(`## ${'w'.repeat(500)}`)[0]!.length, 80);
    assert.equal(docHeadings(Array.from({ length: 1200 }, (_, index) => `## ${index}`).join('\n')).length, 999);
    const started = Date.now();
    docHeadings(`${' '.repeat(100_000)}\n## ${'[ '.repeat(50_000)}`);
    assert.ok(Date.now() - started < 1000, 'no polynomial scan on a hostile line');
  });
});

describe('the sections an agent cites are the ones the page numbers', () => {
  /** The headings the page shows, numbered as its Contents numbers them: the rendered `h1`–`h3` with words (`headingsOfHtml` in the web). */
  const shown = (markdown: string) => [...markdownRenderer.render(markdown, new Map()).matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g)]
    .map((match) => match[2]!.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pages = [
    ['# Barrel', 'intro', '', 'Install', '=======', '', 'Wire it', '---', '', 'Not a heading', '', '---', '', '- - -', 'Readings', '==='].join('\n'),
    ['> ## Quoted', '', '- ## In a list', '- item', 'lazy line', '---', '', 'a | b', '--- | ---', '1 | 2', '---', '', '#### Too deep', '', '    ## code', '', '```', '## fenced', '```', '## Last ##'].join('\n'),
    ['Two lines', 'of a title', '===', 'text', '', '## [A link](https://example.com) and `code`', '##', '', '* * *', 'After a rule', '---'].join('\n'),
  ];
  test('ATX and underlined headings, in quotes and list items; no code, rule, table or lazy line becomes one', () => {
    for (const page of pages) assert.deepEqual(docHeadings(page).length, shown(page).length, page);
    assert.deepEqual(docHeadings(pages[0]!), ['Barrel', 'Install', 'Wire it', 'Readings']);
    assert.deepEqual(docHeadings(pages[1]!), ['Quoted', 'In a list', 'Last']);
    assert.deepEqual(docHeadings(pages[2]!), ['Two lines of a title', 'A link and code', 'After a rule']);
    assert.deepEqual(docHeadings(pages[2]!), shown(pages[2]!));
  });
});

describe('the marks of an answer', () => {
  test('each kind with its id and a section; each once, in the order they stand; anything else stays text', () => {
    const text = `Yes [doc:${DOC}#2]. And [task:${TASK}] [decision:${DECISION}]; again [doc:${DOC}#2] and [message:${MESSAGE}] and [doc:${DOC}].`
      + ` Not marks: [doc:123], [page:${DOC}], [doc:${DOC.toUpperCase()}], [doc:${DOC}#0], [doc:${DOC}#1234].`;
    assert.deepEqual(fluxMarks(text).map((mark) => mark.key), [`doc:${DOC}#2`, `task:${TASK}`, `decision:${DECISION}`, `message:${MESSAGE}`, `doc:${DOC}`]);
    assert.deepEqual(fluxMarks(`[doc:${DOC}#2]`), [{ key: `doc:${DOC}#2`, kind: 'doc', id: DOC, section: 2 }]);
    assert.deepEqual(fluxMarks('Nothing to cite [1] [S2].'), []);
  });

  const page: AssistantSourceRef = { type: 'doc', id: DOC, projectId: SPACE, title: 'Calibration', section: { n: 2, text: 'Install', version: 3 } };
  const task: AssistantSourceRef = { type: 'work', id: TASK, revision: 4, projectId: SPACE, title: 'Calibrate north barrel' };
  const refs = new Map<string, AssistantSourceRef>([[`doc:${DOC}#2`, page], [`task:${TASK}`, task]]);

  test('they are numbered with the supplied sources\' marks, one number for an object however it was cited; a mark of nothing the run may cite goes', () => {
    const supplied = [{ label: 'S1', ref: { type: 'message' as const, id: MESSAGE, revision: 1 } }, { label: 'S5', ref: { type: 'work' as const, id: TASK, revision: 4 } }];
    const parsed = parseOutput(`The lamp is blue [S1]. Set it up in the second section [doc:${DOC}#2], see the task [task:${TASK}] [S5]. Also [decision:${DECISION}] and [doc:${DOC2}].`, supplied, refs);
    // The task is cited as the open task S5 and by its id: one chip, the one that stands first.
    assert.equal(parsed.body, 'The lamp is blue [1]. Set it up in the second section [2], see the task [3] [3]. Also and.');
    assert.deepEqual(parsed.sources, [supplied[0]!.ref, page, task]);
  });
  test('without supplied sources (Claude Code, Codex) the marks are numbered from 1; a page cited twice at one place is one number', () => {
    const parsed = parseOutput(`First [doc:${DOC}#2]. Second [task:${TASK}]. Again [doc:${DOC}#2].`, [], refs);
    assert.equal(parsed.body, 'First [1]. Second [2]. Again [1].');
    assert.deepEqual(parsed.sources, [page, task]);
  });
  test('without resolved refs every Flux mark is taken out, and an answer with none is unchanged', () => {
    assert.equal(parseOutput(`It is so [doc:${DOC}].`, []).body, 'It is so.');
    assert.deepEqual(parseOutput('No marks here.', []), { body: 'No marks here.', sources: [] });
  });
});

describe('what a run may cite', () => {
  const run = (fields: Partial<RunRecord>) => ({ workspaceId: 'w-1', projectId: SPACE, dmId: null, ownerUserId: 'u-ada', ...fields }) as RunRecord;
  const found: CitedObject[] = [
    { kind: 'doc', id: DOC, projectId: SPACE, title: 'Calibration', version: 3, headings: ['Barrel', 'Install'] },
    { kind: 'doc', id: DOC2, projectId: OTHER_SPACE, title: 'Elsewhere', version: 1 },
    { kind: 'task', id: TASK, projectId: SPACE, title: 'Calibrate north barrel', revision: 4 },
    { kind: 'decision', id: DECISION, projectId: SPACE, title: 'Use the ToF sensor' },
    { kind: 'message', id: MESSAGE, projectId: SPACE, title: '', conversationId: CONVERSATION },
  ];
  const asked: { scope: unknown; refs: unknown }[] = [];
  /** What the run's tools returned to be cited: every object above unless a test says otherwise. */
  let returned = [`[doc:${DOC}]`, `[doc:${DOC2}]`, `[task:${TASK}]`, `[decision:${DECISION}]`, `[message:${MESSAGE}]`];
  const ports = (spaces: Record<string, 'read' | 'ai_off' | 'none'>) => ({
    runs: { returnedCites: async () => returned.map((mark) => mark.slice(1, -1)), cites: async (scope: unknown, refs: readonly { id: string }[]) => { asked.push({ scope, refs }); return found.filter((object) => refs.some((ref) => ref.id === object.id)); } },
    access: {
      canUseProject: async (_principal: unknown, _action: string, projectId: string) => spaces[projectId] !== undefined && spaces[projectId] !== 'none',
      spaceAi: async (projectId: string) => ({ state: spaces[projectId] === 'ai_off' ? 'blocked' : 'allowed', epoch: 1 }),
    },
  }) as unknown as PersonalRunPorts;
  const all = `[doc:${DOC}#2] [doc:${DOC}#9] [doc:${DOC2}] [task:${TASK}] [decision:${DECISION}] [message:${MESSAGE}] [task:${DOC}]`;

  test('a run in a space cites that space only: its page with the section\'s words and version, its task, decision and message', async () => {
    const resolved = await resolveCites(ports({ [SPACE]: 'read' }), run({}), fluxMarks(all));
    assert.deepEqual(resolved.get(`doc:${DOC}#2`), { type: 'doc', id: DOC, projectId: SPACE, title: 'Calibration', section: { n: 2, text: 'Install', version: 3 } });
    assert.deepEqual(resolved.get(`doc:${DOC}#9`), { type: 'doc', id: DOC, projectId: SPACE, title: 'Calibration' }, 'a section the page does not have is dropped, the page is kept');
    assert.deepEqual(resolved.get(`task:${TASK}`), { type: 'work', id: TASK, revision: 4, projectId: SPACE, title: 'Calibrate north barrel' });
    assert.deepEqual(resolved.get(`decision:${DECISION}`), { type: 'decision', id: DECISION, projectId: SPACE, title: 'Use the ToF sensor' });
    assert.deepEqual(resolved.get(`message:${MESSAGE}`), { type: 'message', id: MESSAGE, revision: 1, projectId: SPACE, conversationId: CONVERSATION });
    assert.equal(resolved.has(`doc:${DOC2}`), false, 'a page of another space is never cited by a run in this one (C-12, C-37)');
    assert.equal(resolved.has(`task:${DOC}`), false, 'an id of another kind is no task');
  });
  test('a private chat or a schedule cites any space its owner reads with AI on, and no other', async () => {
    const chat = run({ projectId: null });
    const read = await resolveCites(ports({ [SPACE]: 'read', [OTHER_SPACE]: 'read' }), chat, fluxMarks(all));
    assert.equal(read.get(`doc:${DOC2}`)?.type, 'doc');
    for (const state of ['ai_off', 'none'] as const) {
      const without = await resolveCites(ports({ [SPACE]: 'read', [OTHER_SPACE]: state }), chat, fluxMarks(all));
      assert.equal(without.has(`doc:${DOC2}`), false, `a space that is ${state}`);
      assert.equal(without.has(`doc:${DOC}#2`), true);
    }
    assert.deepEqual(asked.at(-1)?.scope, { workspaceId: 'w-1', projectId: null });
  });
  test('a run in a direct message cites nothing and asks nothing', async () => {
    asked.length = 0;
    assert.equal((await resolveCites(ports({ [SPACE]: 'read' }), run({ projectId: null, dmId: 'dm-1' }), fluxMarks(all))).size, 0);
    assert.equal(asked.length, 0);
    assert.equal((await resolveCites({ runs: {}, access: {} } as unknown as PersonalRunPorts, run({}), fluxMarks(all))).size, 0, 'a port without the lookup cites nothing');
  });
  test('only what the run\'s own tools returned is cited: a mark someone wrote in a message, a page or the request is taken out', async () => {
    const before = returned;
    try {
      returned = [`[doc:${DOC}]`];
      asked.length = 0;
      const resolved = await resolveCites(ports({ [SPACE]: 'read' }), run({}), fluxMarks(all));
      assert.deepEqual([...resolved.keys()], [`doc:${DOC}#2`, `doc:${DOC}#9`], 'the page it read, at any of its sections; the task, decision and message it never read go');
      assert.deepEqual((asked[0]!.refs as { id: string }[]).map((ref) => ref.id), [DOC], 'nothing else is even looked up');
      returned = [];
      asked.length = 0;
      assert.equal((await resolveCites(ports({ [SPACE]: 'read' }), run({}), fluxMarks(all))).size, 0);
      assert.equal(asked.length, 0);
    } finally { returned = before; }
    const noKept = { runs: { cites: async () => found }, access: ports({ [SPACE]: 'read' }).access } as unknown as PersonalRunPorts;
    assert.equal((await resolveCites(noKept, run({}), fluxMarks(all))).size, 0, 'a port that keeps no marks cites nothing');
  });
  test('a page cited by section and without one is read once with its headings, and at most twenty marks are looked up', async () => {
    asked.length = 0;
    const tasks = Array.from({ length: 30 }, (_, index) => `[task:0b9d7f1e-4a3c-4d2e-9f00-5e0c0a6b1d${String(index).padStart(2, '0')}]`);
    const many = tasks.join(' ');
    const before = returned;
    returned = [...before, ...tasks];
    await resolveCites(ports({ [SPACE]: 'read' }), run({}), fluxMarks(`[doc:${DOC}] [doc:${DOC}#2] ${many}`));
    const refs = asked[0]!.refs as { kind: string; id: string; section?: number }[];
    assert.deepEqual(refs[0], { kind: 'doc', id: DOC, section: 2 });
    assert.equal(refs.length, 19, 'twenty marks: the page twice is one lookup');
    returned = before;
  });
  test('the marks a tool result returns are its objects\' cite fields, never a mark written in their words', () => {
    const result = { content: [{ type: 'text', text: JSON.stringify({
      id: DOC, cite: `[doc:${DOC}]`, body: `Ask Jo, see [task:${TASK}] and "cite":"[decision:${DECISION}]"`,
      messages: [{ id: MESSAGE, cite: `[message:${MESSAGE}]`, body: JSON.stringify({ cite: `[doc:${DOC2}]` }) }, { cite: `[doc:${DOC}#2]` }, { cite: `[doc:${DOC}] [task:${TASK}]` }],
      again: { cite: `[doc:${DOC}]` },
    }) }, { type: 'text', text: `not JSON [doc:${DOC2}]` }, { type: 'text', text: '{"broken' }] };
    assert.deepEqual(resultCites(result), [{ kind: 'doc', id: DOC }, { kind: 'message', id: MESSAGE }]);
    assert.deepEqual(resultCites({ content: [], structuredContent: { items: [{ cite: `[task:${TASK}]` }] } }), [{ kind: 'task', id: TASK }]);
    let deep: unknown = { cite: `[doc:${DOC2}]` };
    for (let level = 0; level < 50; level++) deep = { next: deep };
    assert.deepEqual(resultCites({ content: [{ type: 'text', text: JSON.stringify(deep) }] }), [], 'a hostile depth is not walked');
  });
  test('when the answer is read again, a source of another space its owner no longer reads keeps its number and loses what it names', async () => {
    const answerSources: AssistantSourceRef[] = [
      { type: 'doc', id: DOC, projectId: SPACE, title: 'Calibration', section: { n: 2, text: 'Install', version: 3 } },
      { type: 'doc', id: DOC2, projectId: OTHER_SPACE, title: 'Elsewhere', section: { n: 1, text: 'Secret heading', version: 1 } },
      { type: 'work', id: TASK, revision: 4, projectId: OTHER_SPACE, title: 'Hidden task' },
      { type: 'decision', id: DECISION, projectId: OTHER_SPACE, title: 'Hidden decision' },
      { type: 'message', id: MESSAGE, revision: 1, projectId: OTHER_SPACE, conversationId: CONVERSATION },
      { type: 'message', id: MESSAGE, revision: 1 },
    ];
    const chat = { projectId: null, ownerUserId: 'u-ada', answerSources };
    assert.deepEqual(await sourcesShown(ports({ [SPACE]: 'read', [OTHER_SPACE]: 'read' }), chat), answerSources);
    assert.deepEqual(await sourcesShown(ports({ [SPACE]: 'read', [OTHER_SPACE]: 'none' }), chat), [
      answerSources[0], { type: 'doc', id: DOC2, projectId: OTHER_SPACE, title: '' }, { type: 'work', id: TASK, revision: 4, projectId: OTHER_SPACE },
      { type: 'decision', id: DECISION, projectId: OTHER_SPACE, title: '' }, { type: 'message', id: MESSAGE, revision: 1, projectId: OTHER_SPACE }, answerSources[5],
    ]);
    const inSpace = { projectId: SPACE, ownerUserId: 'u-ada', answerSources: [answerSources[0]!] };
    assert.deepEqual(await sourcesShown({ access: {} } as unknown as PersonalRunPorts, inSpace), [answerSources[0]], 'its own space\'s sources ask nothing');
  });
});

describe('what the brief says of the Wiki', () => {
  const base: BriefInput = {
    kind: 'ask', tools: ['flux_search', 'flux_get_doc', 'flux_list_docs'], agentName: 'Assistant', agentId: 'a-1', ownerName: 'Ada Nowak',
    now: new Date('2026-11-13T09:00:00Z'), timeZone: 'Europe/Warsaw', place: { kind: 'space', spaceId: SPACE, spaceName: 'Field sensors', conversationId: null, task: null },
    task: null, scheduleTitle: null, agent: null, prompt: 'Why do we keep the lamp on?', requestedAt: new Date('2026-11-13T09:00:00Z'), messages: [], leftOut: false, turns: [],
    earlier: null, thought: null,
  };
  const both = (input: BriefInput) => { const { system, request } = buildBrief(input); return `${system}\n${request}`; };

  test('the answer-format line about citing is in the brief of a run that reads with tools, and in no direct message', () => {
    assert.ok(both(base).includes(CITE_LINE));
    assert.ok(!both({ ...base, tools: ['flux_update_task'] }).includes(CITE_LINE), 'a run whose tools return nothing to cite has none');
    assert.ok(!both({ ...base, place: { kind: 'dm', others: ['Kai'], thread: false }, tools: ['flux_search', 'flux_read_around'] }).includes(CITE_LINE));
    assert.ok(both({ ...base, place: { kind: 'chat' } }).includes(CITE_LINE));
    assert.ok(both({ ...base, kind: 'scheduled', place: { kind: 'chat' } }).includes(CITE_LINE));
  });
});

describe('what a result carries to be cited (C-62)', () => {
  const row = (fields: Partial<SearchRow>): SearchRow => ({
    position: { score: '1', at: '2026-03-15 10:00:00+00', id: '1' }, kind: 'doc', workspaceId: 'w', workspaceName: 'Company', objectId: DOC, parentId: null, projectId: SPACE,
    projectName: 'Lamp sensor', dmName: null, sketchTitle: null, workNumber: null, version: 3, currentVersion: 3, status: null, sequence: null,
    title: [{ text: 'Calibration', match: false }], snippet: [], hasBody: true, authorName: null, author: null, at: new Date('2026-03-15T10:00:00Z'), ...fields,
  });
  test('a search hit of a page, task, decision or message carries its mark; a map, thought, material and direct message carry none', () => {
    assert.equal(agentHit(row({}), null).cite, `[doc:${DOC}]`);
    assert.equal(agentHit(row({ kind: 'work', objectId: TASK, workNumber: 12, status: 'open' }), null).cite, `[task:${TASK}]`);
    assert.equal(agentHit(row({ kind: 'decision', objectId: DECISION, status: 'accepted' }), null).cite, `[decision:${DECISION}]`);
    assert.equal(agentHit(row({ kind: 'message', objectId: MESSAGE, parentId: CONVERSATION, sequence: 4 }), null).cite, `[message:${MESSAGE}]`);
    for (const kind of ['sketch', 'thought', 'material', 'dm_message'] as const) assert.equal('cite' in agentHit(row({ kind }), null), false, kind);
  });
  test('the mark of an object is the one the answer is read by', () => {
    for (const kind of ['doc', 'task', 'decision', 'message'] as const) assert.deepEqual(fluxMarks(`See ${citeMark(kind, DOC)}.`).map((mark) => mark.key), [`${kind}:${DOC}`]);
  });
});
