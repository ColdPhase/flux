import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createDatabase, nativeWorkReadKeys, schema, sql, type NativeWorkReadKey, type NativeWorkViewSelector } from '@flux/db';
import type { WorkReadCursor } from '@flux/contracts';
import { person, project, workspace, type Person } from './support/people.js';

// Actual PostgreSQL key queries over isolated native-schema fixtures. This does not certify
// the not-yet-connected bounded HTTP endpoints, row hydration or client/performance migration.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, pool } = createDatabase(process.env.DATABASE_URL);
after(() => pool.end());
const at = '2026-10-01T06:00:00.123456Z';
const newer = '2026-10-01T06:00:00.123457Z';
const keyCursor = (direction: WorkReadCursor['direction'], key: NativeWorkReadKey): WorkReadCursor => ({ v: 1, direction, scope: 'a'.repeat(64), boundary: { rank: key.rank, id: key.id, createdAt: key.createdAt } });

describe('bounded native PostgreSQL work key selection', () => {
  let owner: Person, other: Person, projectId: string, workspaceId: string;
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const decisions = Array.from({ length: 3 }, () => randomUUID());
  const results = Array.from({ length: 2 }, () => randomUUID());
  const actor = () => ({ kind: 'human' as const, id: owner.id });
  const tasks: NativeWorkViewSelector = { purpose: 'tasks', group: 'all', mine: false };
  const read = (selection: NativeWorkViewSelector = tasks, limit = 50, cursor?: WorkReadCursor) => db.transaction(
    (tx) => nativeWorkReadKeys(tx).view(projectId, actor(), selection, limit, cursor), { isolationLevel: 'repeatable read', accessMode: 'read only' });

  before(async () => {
    [owner, other] = await Promise.all(['key-owner', 'key-other'].map(person));
    const ws = await workspace(owner, 'Native key test'); workspaceId = ws.id;
    projectId = (await project(owner, ws.id, 'Bounded native keys', 'restricted')).id;
    await db.insert(schema.projectDecisions).values(decisions.map((id, i) => ({ id, workspaceId, projectId, title: `Decision ${i}`, status: (['proposed', 'accepted', 'superseded'] as const)[i]!, proposedByKind: 'human' as const, proposedById: other.id, createdAt: new Date(at) })));
    await db.insert(schema.projectWorkItems).values(ids.map((id, i) => ({
      id, workspaceId, projectId, title: i === 0 ? '100%_literal' : i === 1 ? '100xxliteral' : `Work ${i}`, outcome: 'Own complete fields must not enter keys',
      status: (['open', 'open', 'in_progress', 'blocked', 'open', 'done', 'not_pursued', 'in_progress'] as const)[i]!,
      ownerUserId: i % 2 === 0 ? owner.id : other.id, createdByKind: 'human' as const, createdById: owner.id,
      parkedAt: i === 4 || i === 7 ? new Date(at) : null, parkedByDecisionId: i === 4 || i === 7 ? decisions[1] : null, createdAt: new Date(at),
    })));
    await db.insert(schema.projectWorkItems).values(Array.from({ length: 110 }, (_, i) => ({ id: randomUUID(), workspaceId, projectId, title: `Additional native ${i}`,
      ownerUserId: other.id, createdByKind: 'human' as const, createdById: owner.id, createdAt: new Date(at) })));
    await db.insert(schema.projectResults).values(results.map((id, i) => ({ id, workspaceId, projectId, title: `Result ${i}`, finding: 'negative' as const, createdByKind: 'human' as const, createdById: i ? other.id : owner.id, createdAt: new Date(at) })));
    // Explicit raw native precision fixture: JS Date cannot represent these adjacent keys.
    await db.execute(sql`UPDATE ${schema.projectWorkItems} SET created_at = ${at}::timestamptz WHERE project_id = ${projectId}::uuid`);
    await db.execute(sql`UPDATE ${schema.projectWorkItems} SET created_at = ${newer}::timestamptz WHERE id = ${ids[1]}::uuid`);
    await db.execute(sql`UPDATE ${schema.projectDecisions} SET created_at = ${at}::timestamptz WHERE project_id = ${projectId}::uuid`);
    await db.execute(sql`UPDATE ${schema.projectResults} SET created_at = ${at}::timestamptz WHERE project_id = ${projectId}::uuid`);
  });

  test('all native bands remain reachable through bounded forward and direct previous pages', async () => {
    const seen: NativeWorkReadKey[] = [];
    let cursor: WorkReadCursor | undefined;
    let previousPage: NativeWorkReadKey[] = [];
    while (true) {
      const page = await read(tasks, 17, cursor);
      assert.equal(page.total, 123); assert.equal(page.before, seen.length); assert.ok(page.items.length <= 17);
      assert.equal(page.hasBefore, seen.length > 0);
      for (const key of page.items) assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'id', 'kind', 'rank']);
      if (page.hasBefore) {
        const previous = await read(tasks, 17, keyCursor('previous', page.items[0]!));
        assert.deepEqual(previous.items, previousPage, 'previous reload needs no client history to recover the immediately prior page');
      }
      seen.push(...page.items); previousPage = page.items;
      if (!page.hasAfter) break;
      cursor = keyCursor('next', page.items.at(-1)!);
    }
    assert.equal(new Set(seen.map((key) => `${key.kind}:${key.id}`)).size, 123);
    assert.deepEqual([...new Set(seen.map((key) => key.rank))], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(seen.find((key) => key.id === ids[0])?.createdAt, at);
    assert.equal(seen.find((key) => key.id === ids[1])?.createdAt, newer);
    assert.ok(seen.findIndex((key) => key.id === ids[1]) < seen.findIndex((key) => key.id === ids[0]));
    assert.equal((await read(tasks, 100)).items.length, 100, 'only returned keys, never the overfetch key, may be hydrated');
  });

  test('mine uses native owner/result creator while keeping proposals and excluding rules', async () => {
    const page = await read({ purpose: 'tasks', group: 'all', mine: true }, 100);
    assert.equal(page.total, 6); // 4 own work + project-wide proposal + own result.
    assert.deepEqual(new Set(page.items.map((key) => key.id)), new Set([ids[0], ids[2], ids[4], ids[6], decisions[0], results[0]]));
    assert.equal((await read({ purpose: 'tasks', group: 'rules', mine: true })).total, 0);
    const parked = await read({ purpose: 'tasks', group: 'parked', mine: false });
    assert.deepEqual(new Set(parked.items.map((key) => key.id)), new Set([ids[4], ids[7]]));
  });

  test('choice predicates retain parked result choices, full native kinds and literal wildcard search', async () => {
    const choose = (choice: 'pivot_work' | 'result_work', q = ''): NativeWorkViewSelector => ({ purpose: 'choices', choice, q });
    assert.equal((await read(choose('pivot_work'), 100)).total, 114);
    assert.equal((await read(choose('result_work'), 100)).total, 116);
    const literal = await read(choose('result_work', '100%_'));
    assert.deepEqual(literal.items.map((key) => key.id), [ids[0]]);
    assert.equal((await read({ purpose: 'choices', choice: 'accepted_decisions', q: '' })).total, 1);
    assert.equal((await read({ purpose: 'choices', choice: 'doc_refs', kind: 'decision', q: '' })).total, 3);
    assert.equal((await read({ purpose: 'choices', choice: 'parked_work', decisionId: decisions[1]!, q: '' })).total, 2);
  });

  test('a surviving boundary alone yields no false strict escape; an older/newer scope retains its actual opposite', async () => {
    const single = await read({ purpose: 'choices', choice: 'accepted_decisions', q: '' }, 1);
    const boundary = single.items[0]!;
    for (const direction of ['next', 'previous'] as const) {
      const empty = await read({ purpose: 'choices', choice: 'accepted_decisions', q: '' }, 1, keyCursor(direction, boundary));
      assert.equal(empty.total, 1); assert.deepEqual(empty.items, []); assert.equal(empty.hasBefore, false); assert.equal(empty.hasAfter, false);
    }
    const recent = await read({ purpose: 'choices', choice: 'doc_refs', kind: 'work', q: '100' }, 1);
    const older = await read({ purpose: 'choices', choice: 'doc_refs', kind: 'work', q: '100' }, 1, keyCursor('next', recent.items[0]!));
    assert.deepEqual(older.items.map((key) => key.id), [ids[0]]);
    const end = await read({ purpose: 'choices', choice: 'doc_refs', kind: 'work', q: '100' }, 1, keyCursor('next', older.items[0]!));
    assert.equal(end.before, 2); assert.equal(end.hasBefore, true); assert.equal(end.hasAfter, false);
  });
});
