import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertEmptyWorkReadQuery, decodeWorkReadCursor, encodeWorkReadCursor, parseWorkAssociationRead,
  parseWorkRelationRead, parseWorkViewRead, presentWorkReadPage, workReadScope,
} from '@flux/core';

const a = '00000000-0000-0000-0000-000000000001';
const b = '00000000-0000-0000-0000-000000000002';
const actor = { kind: 'human' as const, id: 'native-human-id' };
const params = (value: string) => new URLSearchParams(value);
const invalid = (run: () => unknown) => assert.throws(run, { status: 400, code: 'INVALID_WORK_READ' });
const key = { rank: 2, createdAt: '2026-10-01T06:00:00.123456Z', id: a };
const scope = workReadScope('view', a, actor, parseWorkViewRead(params('')).selection, 50);

test('task URL fields default explicitly and reject duplicates/unknown/coerced selectors', () => {
  assert.deepEqual(parseWorkViewRead(params('')), { limit: 50, selection: { purpose: 'tasks', group: 'all', mine: false } });
  assert.equal(parseWorkViewRead(params('group=parked&mine=true&limit=100')).limit, 100);
  for (const input of ['mine=1', 'mine=', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'limit=50&limit=50', 'group=todo', 'q=secret', 'purpose=unknown', 'group=open&selected='+a]) invalid(() => parseWorkViewRead(params(input)));
  invalid(() => assertEmptyWorkReadQuery(params('limit=50')));
});

test('native choices stay disjoint; parked result choices keep a separate deep selection', () => {
  for (const choice of ['accepted_decisions', 'pivot_work', 'result_work']) assert.equal(parseWorkViewRead(params(`purpose=choices&choice=${choice}`)).selection.purpose, 'choices');
  assert.deepEqual(parseWorkViewRead(params(`purpose=choices&choice=result_work&selected=${a}&q=%20board%20`)).selection,
    { purpose: 'choices', choice: 'result_work', q: 'board', selected: a });
  assert.deepEqual(parseWorkViewRead(params(`purpose=choices&choice=parked_work&decisionId=${b}`)).selection,
    { purpose: 'choices', choice: 'parked_work', q: '', decisionId: b });
  for (const input of ['choice=pivot_work', 'purpose=choices&choice=pivot_work&mine=true', 'purpose=choices&choice=accepted_decisions&selected='+a,
    'purpose=choices&choice=parked_work', 'purpose=choices&choice=doc_refs', 'purpose=choices&choice=doc_refs&kind=message', 'purpose=choices&choice=result_work&decisionId='+a]) invalid(() => parseWorkViewRead(params(input)));
  invalid(() => parseWorkViewRead(params('purpose=choices&choice=doc_refs&kind=work&q='+'a'.repeat(201))));
  invalid(() => parseWorkViewRead(params('purpose=choices&choice=pivot_work&q=%00')));
});

test('source batch bounds apply before deduplication and conversation/source cursors are exclusive', () => {
  assert.deepEqual(parseWorkAssociationRead(params(`messageIds=${b},${a},${b}`)).selection, { relation: 'source', messageIds: [a, b] });
  assert.deepEqual(parseWorkAssociationRead(params(`conversationId=${b}&relation=any`)).selection, { relation: 'any', conversationId: b });
  for (const input of ['', `messageIds=${a}&conversationId=${b}`, `messageIds=${a}&sourceCursor=abc`, 'messageIds=not-a-uuid', `messageIds=${a},`,
    `messageIds=${a}&relation=other`, 'messageIds='+Array(101).fill(a).join(',')]) invalid(() => parseWorkAssociationRead(params(input)));
});

test('relationship batches retain kind identities and reject malformed/oversized selectors', () => {
  assert.deepEqual(parseWorkRelationRead(params(`objects=result:${a},work:${a},work:${a}&role=about`)).selection,
    { objects: [{ kind: 'result', id: a }, { kind: 'work', id: a }], role: 'about' });
  for (const input of ['', 'objects=thought:'+a, 'objects=work:'+a+':1', 'objects=work:'+a+'&role=hidden', 'objects='+Array(101).fill('work:'+a).join(',')]) invalid(() => parseWorkRelationRead(params(input)));
});

test('cursor survives direct reload/previous direction with all PostgreSQL microseconds', () => {
  const encoded = encodeWorkReadCursor('previous', scope, key);
  assert.ok(encoded.length <= 512);
  assert.deepEqual(decodeWorkReadCursor(encoded, scope), { v: 1, direction: 'previous', scope, boundary: key });
  const adjacent = { ...key, createdAt: '2026-10-01T06:00:00.123457Z' };
  assert.notEqual(encodeWorkReadCursor('previous', scope, adjacent), encoded, 'two native microsecond keys must not collapse into milliseconds');
  assert.equal(decodeWorkReadCursor(undefined, scope), undefined);
  invalid(() => encodeWorkReadCursor('next', scope, { ...key, createdAt: '2026-02-30T00:00:00.123456Z' }));
  invalid(() => encodeWorkReadCursor('next', scope, { ...key, createdAt: '2026-10-01T06:00:00.123Z' }));
  invalid(() => encodeWorkReadCursor('next', scope, { ...key, createdAt: '0000-01-01T00:00:00.123456Z' }));
});

test('cursor cannot transfer between account/project/endpoint/selector/limit/object window', () => {
  const encoded = encodeWorkReadCursor('next', scope, key);
  for (const changed of [workReadScope('view', b, actor, { purpose: 'tasks', group: 'all', mine: false }, 50),
    workReadScope('view', a, { ...actor, id: 'another-native-human' }, { purpose: 'tasks', group: 'all', mine: false }, 50),
    workReadScope('relations', a, actor, { purpose: 'tasks', group: 'all', mine: false }, 50),
    workReadScope('view', a, actor, { purpose: 'tasks', group: 'all', mine: true }, 50),
    workReadScope('view', a, actor, { purpose: 'tasks', group: 'all', mine: false }, 100),
    workReadScope('view', a, actor, { purpose: 'tasks', group: 'all', mine: false }, 50, [{ kind: 'work', id: a }])]) invalid(() => decodeWorkReadCursor(encoded, changed));
});

test('normalized 100-source selector produces a fixed-size scoped cursor without source identities', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `00000000-0000-0000-0000-${String(i+1).padStart(12, '0')}`);
  const s1 = parseWorkAssociationRead(params('messageIds='+ids.join(','))).selection;
  const s2 = parseWorkAssociationRead(params('messageIds='+[...ids].reverse().join(','))).selection;
  const digest = workReadScope('associations', a, actor, s1, 50);
  assert.equal(digest, workReadScope('associations', a, actor, s2, 50));
  const encoded = encodeWorkReadCursor('next', digest, key);
  assert.ok(encoded.length <= 512);
  assert.equal(JSON.parse(Buffer.from(encoded,'base64url').toString()).scope.length, 64);
  assert.equal(Buffer.from(encoded,'base64url').toString().includes(ids[99]!), false);
});

test('unknown/noncanonical/duplicate cursor JSON cannot bypass the closed envelope', () => {
  const wire = (value: string) => Buffer.from(value).toString('base64url');
  const valid = { v: 1, direction: 'next', scope, boundary: key };
  for (const value of ['', 'x'.repeat(513), wire(JSON.stringify({ ...valid, admin: true })), wire(JSON.stringify({ ...valid, v: 2 })),
    wire(JSON.stringify({ ...valid, boundary: { ...key, extra: true } })), wire(JSON.stringify(valid).replace('"v":1','"v":0,"v":1')),
    wire(JSON.stringify({ ...valid, boundary: { ...key, rank: 9 } }))]) invalid(() => decodeWorkReadCursor(value, scope));
});

test('page metadata emits both native directions and keeps an empty changed-page escape', () => {
  const page = presentWorkReadPage({ items: [{ value: { id: a }, key }], total: 12, before: 4, hasBefore: true, hasAfter: true }, 1, scope);
  assert.equal(decodeWorkReadCursor(page.previousCursor!, scope)?.direction, 'previous');
  assert.equal(decodeWorkReadCursor(page.nextCursor!, scope)?.direction, 'next');
  const supplied = decodeWorkReadCursor(page.nextCursor!, scope)!;
  const empty = presentWorkReadPage({ items: [], total: 4, before: 4, hasBefore: true, hasAfter: false }, 1, scope, supplied);
  assert.equal(empty.total, 4);
  assert.ok(empty.previousCursor);
  assert.equal(empty.nextCursor, null);
  assert.throws(() => presentWorkReadPage({ items: [{ value: 1, key }], total: 0, before: 0, hasBefore: false, hasAfter: false }, 1, scope));
  assert.throws(() => presentWorkReadPage({ items: [], total: 5, before: 3, hasBefore: true, hasAfter: true }, 1, scope));
  assert.throws(() => presentWorkReadPage({ items: [], total: 4, before: 3, hasBefore: true, hasAfter: true }, 1, scope, supplied));
  const previous = decodeWorkReadCursor(page.previousCursor!, scope)!;
  assert.throws(() => presentWorkReadPage({ items: [], total: 4, before: 1, hasBefore: false, hasAfter: true }, 1, scope, previous));
  assert.throws(() => presentWorkReadPage({ items: [], total: 4, before: 0, hasBefore: true, hasAfter: true }, 1, scope, previous));
  assert.deepEqual(presentWorkReadPage({ items: [], total: 0, before: 0, hasBefore: false, hasAfter: false }, 50, scope),
    { items: [], total: 0, before: 0, limit: 50, previousCursor: null, nextCursor: null });
});
