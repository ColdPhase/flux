import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { agentHit, agentSearchPlan, agentSearchTime, agentSearchWords, authorsNamed, isAuthorName, markedText, type AuthorCandidate, type SearchRow } from '@flux/core';

// What an agent's search means and how a hit is told (F-042, AG-12, #1290), with no database: the words, the dates, the plan and the compact hit.

const scope = { reader: 'u-ada', place: null, conversationId: null } as const;
const row = (fields: Partial<SearchRow>): SearchRow => ({
  position: { score: '1', at: '2026-03-15 10:00:00+00', id: '1' }, kind: 'message', workspaceId: 'w', workspaceName: 'Company', objectId: 'm-1', parentId: 'c-1', projectId: 'p-1',
  projectName: 'Lamp sensor', dmName: null, sketchTitle: null, workNumber: null, version: null, currentVersion: null, status: null, sequence: 4,
  title: [], snippet: [{ text: 'Kalibracja ', match: true }, { text: 'czujników jest w piątek.', match: false }], hasBody: true, authorName: 'Jonas Berg', author: { kind: 'human', id: 'u-jonas' },
  at: new Date('2026-03-15T10:00:00Z'), ...fields,
});

describe('the words of an agent\'s query', () => {
  test('letters and digits only, lower case, each once: a query carries no operator, quote or minus', () => {
    assert.deepEqual(agentSearchWords('  Czujnik "kalibracja" -piątek OR czujnik! #12 SHT45 '), ['czujnik', 'kalibracja', 'piątek', 'or', '12', 'sht45']);
    assert.deepEqual(agentSearchWords('Łódź żółć'), ['łódź', 'żółć']);
  });
  test('nothing to search for, and too much, are refused in words the model can act on', () => {
    for (const q of ['', '   ', '!!! ---', '"" ()']) assert.throws(() => agentSearchWords(q), { code: 'QUERY_REQUIRED' }, JSON.stringify(q));
    assert.throws(() => agentSearchWords('a'.repeat(301)), { code: 'QUERY_TOO_LONG' });
    assert.equal(agentSearchWords(Array.from({ length: 50 }, (_, index) => `w${index}`).join(' ')).length, 30, 'at most thirty words');
  });
});

describe('the dates of an agent\'s filters', () => {
  test('a date is its midnight in UTC, a time keeps its offset, and a day that does not exist is not rolled over', () => {
    assert.equal(agentSearchTime('2026-09-01', 'after').toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(agentSearchTime('2026-09-01T08:30:00Z', 'after').toISOString(), '2026-09-01T08:30:00.000Z');
    assert.equal(agentSearchTime('2026-09-01T10:30:15+02:00', 'before').toISOString(), '2026-09-01T08:30:15.000Z');
    assert.equal(agentSearchTime('2026-09-01 10:30-0530', 'before').toISOString(), '2026-09-01T16:00:00.000Z');
    for (const bad of ['yesterday', '2026-02-31', '2026-13-01', '01.09.2026', '2026-09-01T25:00:00Z', '2026-09-01T08:00:00', '']) assert.throws(() => agentSearchTime(bad, 'after'), { code: 'INVALID_TIME' }, bad);
    assert.throws(() => agentSearchTime('nope', 'before'), /before is a date like 2026-09-01/);
  });
});

describe('the plan of a search', () => {
  test('any word in the place the server decided, the reader\'s own id, ten hits unless asked for more', () => {
    const plan = agentSearchPlan({ q: 'Czujnik kalibracja' }, { ...scope, place: { type: 'project', id: 'p-1' }, conversationId: 'c-1' });
    assert.deepEqual([plan.words, plan.limit, plan.place, plan.conversationId, plan.reader, plan.after, plan.authorId, plan.since, plan.until],
      ['czujnik kalibracja', 10, { type: 'project', id: 'p-1' }, 'c-1', 'u-ada', null, null, null, null]);
    assert.deepEqual(plan.kinds, ['message', 'dm_message', 'doc', 'material', 'file', 'work', 'decision', 'sketch', 'thought'], 'every kind an agent finds, the text of files too (C-63): never a person or a space\'s own row');
  });
  test('a kind, an author and a range narrow it; a range backwards, a limit out of bounds and an unknown kind are refused', () => {
    const plan = agentSearchPlan({ q: 'x', kind: 'task', from: ' u-jonas ', after: '2026-03-01', before: '2026-04-01', limit: 25 }, scope);
    assert.deepEqual([plan.kinds, plan.authorId, plan.since?.toISOString(), plan.until?.toISOString(), plan.limit], [['work'], 'u-jonas', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 25]);
    assert.deepEqual(agentSearchPlan({ q: 'x', kind: 'map' }, scope).kinds, ['sketch', 'thought']);
    assert.deepEqual(agentSearchPlan({ q: 'x', kind: 'message' }, scope).kinds, ['message', 'dm_message']);
    assert.deepEqual(agentSearchPlan({ q: 'x', kind: 'file' }, scope).kinds, ['file']);
    assert.throws(() => agentSearchPlan({ q: 'x', after: '2026-04-01', before: '2026-03-01' }, scope), { code: 'INVALID_TIME' });
    assert.throws(() => agentSearchPlan({ q: 'x', after: '2026-04-01', before: '2026-04-01' }, scope), { code: 'INVALID_TIME' });
    for (const limit of [0, 26, 1.5]) assert.throws(() => agentSearchPlan({ q: 'x', limit }, scope), { code: 'INVALID_LIMIT' }, String(limit));
    assert.throws(() => agentSearchPlan({ q: 'x', kind: 'person' as never }, scope), { code: 'INVALID_TYPE' });
  });
});

describe('a hit as the model is told it', () => {
  test('a message: its words with the matches in bold, where it is, who wrote it as labelled, and what to read around it with', () => {
    assert.equal(markedText([{ text: 'a ', match: false }, { text: 'b', match: true }]), 'a **b**');
    const hit = agentHit(row({}), { kind: 'human', id: 'u-jonas', name: 'Jonas Berg' });
    assert.deepEqual([hit.kind, hit.id, hit.link, hit.conversationId, hit.sequence, hit.author?.name], ['message', 'm-1', '/projects/p-1/conversations/c-1#message-m-1', 'c-1', 4, 'Jonas Berg']);
    assert.equal(hit.snippet, '**Kalibracja **czujników jest w piątek.');
    assert.deepEqual(hit.place, { type: 'space', id: 'p-1', name: 'Lamp sensor' });
  });
  test('the raw name is never told: a hit has the author the server labelled, or none', () => {
    assert.equal(agentHit(row({ authorName: 'Secret Name' }), null).author, undefined);
    assert.ok(!JSON.stringify(agentHit(row({ authorName: 'Secret Name' }), { kind: 'human', id: 'u', name: 'Former member' })).includes('Secret Name'));
  });
  test('a direct message: its place is the direct message, and its link opens it', () => {
    const hit = agentHit(row({ kind: 'dm_message', parentId: 'd-1', projectId: null, projectName: null, dmName: 'Jonas Berg' }), null);
    assert.deepEqual([hit.kind, hit.link, hit.place, hit.conversationId, hit.sequence], ['message', '/dm/d-1#message-m-1', { type: 'dm', id: 'd-1', name: 'Jonas Berg' }, undefined, 4]);
  });
  test('a task, a Wiki page and a decision carry their title, number, status and version, and a snippet of the body when it has one', () => {
    const task = agentHit(row({ kind: 'work', objectId: 'w-1', title: [{ text: 'Order a ', match: false }, { text: 'czujnik', match: true }], snippet: null, workNumber: 12, status: 'in_progress', sequence: null }), null);
    assert.deepEqual([task.kind, task.title, task.number, task.status, task.snippet, task.link], ['task', 'Order a czujnik', 12, 'in_progress', undefined, '/projects/p-1/tasks?open=work:w-1']);
    const doc = agentHit(row({ kind: 'doc', objectId: 'd-1', version: 3, title: [{ text: 'Notes', match: false }], snippet: [{ text: 'See ', match: false }, { text: 'czujnik', match: true }], sequence: null }), null);
    assert.deepEqual([doc.kind, doc.title, doc.version, doc.snippet, doc.sequence, doc.conversationId], ['doc', 'Notes', 3, 'See **czujnik**', undefined, undefined]);
    const decision = agentHit(row({ kind: 'decision', objectId: 'x-1', status: 'accepted', title: [{ text: 'Use LoRa', match: false }], snippet: null, sequence: null }), null);
    assert.deepEqual([decision.kind, decision.status, decision.title], ['decision', 'accepted', 'Use LoRa']);
  });
  test('a thought is a thought of a map, found by the map filter', () => {
    const hit = agentHit(row({ kind: 'thought', objectId: 't-1', parentId: 'k-1', projectId: 'p-1', title: [{ text: 'ToF sensor', match: false }], snippet: null, sequence: null }), null);
    assert.deepEqual([hit.kind, hit.snippet, hit.link], ['thought', 'ToF sensor', '/map/k-1#thought-t-1']);
  });
});

describe('an author by name (#1410)', () => {
  const people: AuthorCandidate[] = [
    { kind: 'human', id: 'u-maurycy', name: 'Maurycy Zamojski' }, { kind: 'human', id: 'u-ada', name: 'Ada Nowak' }, { kind: 'human', id: 'u-adam', name: 'Adam Łęcki' },
    { kind: 'human', id: 'u-marek', name: 'Marek Wiśniewski' }, { kind: 'human', id: 'u-marta', name: 'Marta Kos' },
    { kind: 'agent', id: 'a-1', name: 'Assistant', ownerName: 'Ada Nowak' }, { kind: 'agent', id: 'a-2', name: 'Assistant', ownerName: 'Marta Kos' },
  ];
  const ids = (from: string) => authorsNamed(from, people).map((author) => author.id);

  test('a first name, a full name, another case ending, accents and case aside', () => {
    for (const from of ['Maurycy', 'maurycy zamojski', 'Maurycego', 'MAURYCY', 'Zamojski']) assert.deepEqual(ids(from), ['u-maurycy'], from);
    assert.deepEqual(ids('Adam Lecki'), ['u-adam'], 'ł and ę folded');
    assert.deepEqual(ids('Ada'), ['u-ada'], 'an exact word wins over a longer name that begins with it');
    assert.deepEqual(ids('Marek'), ['u-marek'], 'two names that only begin alike are not one');
    assert.deepEqual(ids('Mar'), ['u-marek', 'u-marta'], 'a beginning that fits several is several');
    assert.deepEqual(ids('Zbigniew'), []);
  });

  test('agents by their name, and by the name people see, with whose they are', () => {
    assert.deepEqual(ids('Assistant'), ['a-1', 'a-2']);
    assert.deepEqual(ids('Assistant (Marta\'s agent)'), ['a-2']);
    assert.deepEqual(ids('Assistant (Ada Nowak’s agent)'), ['a-1']);
    assert.deepEqual(ids('Ada Nowak (Marta\'s agent)'), [], 'a person is never an agent');
  });

  test('an id is not a name: a uuid, or a long account id with a digit', () => {
    assert.equal(isAuthorName('6810ef5a-9ce9-47d5-914b-7613ef09ab72'), false);
    assert.equal(isAuthorName('Xk2vQ9mRtY7bLp3sWn5cFh8d'), false);
    for (const name of ['Maurycy', 'Ada Nowak', 'Assistant (Ada\'s agent)', 'Bartholomew-Featherstonehaugh']) assert.equal(isAuthorName(name), true, name);
  });
});
