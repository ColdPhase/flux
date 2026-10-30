import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { workspaceUnlockGrantsPath, workspaceUnlockPasswordPath, workspaceRecoveryCodePath } from '@flux/contracts';
import { Readable } from 'node:stream';
import {
  generateHolderKeyPair, holderMac, holderSecretCheck, keyCheckValue, keyCommitment, newDek, newKdfParams, realSeal, rotateFileObject, sealDekToHolder, sealField,
  wrapPrivateKey, WorkspaceKey, type RotationFileObjects,
} from '@flux/core';
import { pool } from './support/db.js';
import { codeOf, createSealed, lock, passphrase, readWorkspace, unlock } from './support/encryption.js';
import {
  checkValues, deksOf, endOffline, fileObjects, filesOpened, holderRows, holdersOpenedBy, openHolder, opened, storedEnvelopes, wrapRows, type HolderRow,
} from './support/encryption-offline.js';
import { addMember, expectStatus, person, removeMember, type Person } from './support/people.js';

// F-030 S2c (#655; docs/product/encrypted-workspaces.md#rotation), AC-13: removing an owner or admin changes the
// workspace key and re-encrypts everything, so the removed person's password, the old DEK and the old recovery code
// open nothing in a copy taken after the finish. The worker runs the rotation (pages of FLUX_TEST_ROTATION_PAGE_SIZE,
// sweep every FLUX_TEST_ROTATION_SWEEP_MS in docker/compose.encryption.test.yaml). The crash and keyring-restart cases are
// `encryption-rotation.check.ts`, run by scripts/check_encryption.sh around `docker kill` and restarts.

after(() => endOffline());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const key = () => ({ 'idempotency-key': randomUUID() });
const secrets = new Set<string>();

interface Keys { current_version: number; live_versions: number[]; rotation: string; tampered_at: Date | null }
const keysOf = async (ws: string) => (await pool.query<Keys>('SELECT current_version, live_versions, rotation, tampered_at FROM workspace_keys WHERE workspace_id = $1', [ws])).rows[0]!;
async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, ms = 90_000, every = 50): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await sleep(every);
  }
}
const settled = (ws: string, version: number) => waitFor(`rotation of ${ws} to v${version}`, async () => {
  const k = await keysOf(ws);
  return k.rotation === 'none' && k.current_version === version ? k : null;
});
const running = (ws: string, version: number) => waitFor(`v${version} running`, async () => {
  const k = await keysOf(ws);
  return k.rotation === 'reencrypting' && k.current_version === version ? k : null;
}, 60_000, 10);
const events = async (ws: string, kind: string) => (await pool.query('SELECT data FROM events WHERE workspace_id = $1 AND kind = $2 ORDER BY seq', [ws, kind])).rows
  .map((row) => row.data as Record<string, unknown>);
const unlockRowCount = async (ws: string) => (await pool.query('SELECT count(*)::int AS n FROM workspace_unlocks WHERE workspace_id = $1', [ws])).rows[0].n as number;
const holderOf = async (ws: string, userId: string) => (await holderRows(ws)).find((row) => row.user_id === userId)!;

interface Club { ws: string; owner: Person; ownerPw: string; recovery: string; people: Record<string, { who: Person; pw: string | null }> }

/** Ada (owner) creates the club; each named admin gets an unlock password through Ada's grant; members and guests none. */
async function club(name: string, admins: string[], others: Record<string, 'member' | 'guest' | 'admin' | 'owner'> = {}): Promise<Club> {
  const owner = await person('Ada');
  const ownerPw = passphrase();
  const { workspace, recoveryCode } = await createSealed(owner, name, ownerPw);
  secrets.add(ownerPw).add(recoveryCode);
  const people: Club['people'] = {};
  for (const label of admins) {
    const who = await person(label);
    const pw = passphrase();
    secrets.add(pw);
    await addMember(owner, workspace.id, who, 'admin');
    expectStatus(await owner.browser.request('POST', workspaceUnlockGrantsPath(workspace.id), { body: { userId: who.id, password: ownerPw } }), 201);
    expectStatus(await who.browser.request('PUT', workspaceUnlockPasswordPath(workspace.id), { body: { newPassword: pw } }), 200);
    people[label] = { who, pw };
  }
  for (const [label, role] of Object.entries(others)) {
    const who = await person(label);
    await addMember(owner, workspace.id, who, role);
    people[label] = { who, pw: null };
  }
  await pool.query('DELETE FROM password_attempts WHERE workspace_id = $1', [workspace.id]);
  return { ws: workspace.id, owner, ownerPw, recovery: recoveryCode, people };
}

/** A project, a conversation with `count` messages, a DM, a decision and a draft, each with a canary. */
async function seed(c: Club, count: number) {
  const canary = (kind: string) => `canary-${kind}-${randomUUID()}`;
  const post = async (path: string, body: unknown) => expectStatus(await c.owner.browser.request('POST', path, { body, headers: key() }), 201, path) as Record<string, unknown>;
  const texts = { project: canary('project'), dm: canary('dm'), decision: canary('decision'), draft: canary('draft'), messages: [] as string[] };
  const project = await post(`/api/v1/workspaces/${c.ws}/projects`, { name: texts.project, visibility: 'workspace' });
  texts.messages.push(canary('opening'));
  const conversation = await post(`/api/v1/projects/${project.id}/conversations`, { body: texts.messages[0], clientMessageId: randomUUID() });
  for (let i = 1; i < count; i += 10) {
    const batch = Array.from({ length: Math.min(10, count - i) }, () => canary('message'));
    texts.messages.push(...batch);
    await Promise.all(batch.map((body) => post(`/api/v1/conversations/${conversation.id}/messages`, { body, clientMessageId: randomUUID() })));
  }
  const dm = await post(`/api/v1/workspaces/${c.ws}/dms`, { participantIds: Object.values(c.people).map((p) => p.who.id).slice(0, 1) });
  await post(`/api/v1/dms/${dm.id}/messages`, { body: texts.dm, clientMessageId: randomUUID() });
  const decision = await post(`/api/v1/projects/${project.id}/decisions`, { title: texts.decision, rationale: canary('rationale') });
  const draft = await post(`/api/v1/workspaces/${c.ws}/drafts`, { title: texts.draft, body: canary('draft-body') });
  return { texts, ids: { project: project.id as string, conversation: conversation.id as string, dm: dm.id as string, decision: decision.id as string, draft: draft.id as string } };
}

/** What a person removed could have kept: their holder row and wraps, and the DEKs their password opens. */
async function keptBy(ws: string, userId: string, pw: string) {
  const holder = await holderOf(ws, userId);
  const wraps = await wrapRows(ws);
  const privateKey = await openHolder(holder, pw);
  assert.ok(privateKey, 'the password opens its own holder before the removal');
  const deks = deksOf(holder, privateKey, wraps);
  for (const dek of deks.values()) secrets.add(dek.toString('base64url'));
  return { holder, wraps: wraps.filter((row) => row.holder_id === holder.id), deks };
}

/** The checks of a logical copy taken after the finish (AC-13). */
async function copyOpensNothing(ws: string, version: number, removed: { pw: string; deks: Map<number, Buffer> }[], oldCodes: string[]) {
  const holders = await holderRows(ws);
  for (const person of removed) assert.deepEqual(await holdersOpenedBy(holders, person.pw), [], 'a removed person\'s password opens no holder');
  for (const code of oldCodes) assert.deepEqual(await holdersOpenedBy(holders, code), [], 'the old recovery code opens no holder');
  const envelopes = [...await storedEnvelopes(ws), ...await checkValues(ws)];
  assert.ok(envelopes.length > 0);
  assert.deepEqual(envelopes.filter((row) => row.version !== version).map((row) => `${row.table}.${row.column}`), [], `every envelope is at v${version}`);
  const objects = await fileObjects(ws);
  for (const person of removed) {
    for (const dek of person.deks.values()) {
      assert.equal(opened(ws, dek, envelopes), 0, 'an old DEK opens no envelope');
      assert.equal(filesOpened(ws, dek, objects), 0, 'an old DEK opens no file object');
    }
  }
  const old = await pool.query(`SELECT (SELECT count(*) FROM workspace_dek_wraps WHERE workspace_id = $1 AND key_version < $2)::int AS wraps,
    (SELECT count(*) FROM workspace_unlocks WHERE workspace_id = $1 AND key_version < $2)::int AS unlocks,
    (SELECT count(*) FROM workspace_key_versions WHERE workspace_id = $1 AND key_version < $2)::int AS versions`, [ws, version]);
  assert.deepEqual(old.rows[0], { wraps: 0, unlocks: 0, versions: 0 }, 'no wrap, unlock row or key version below the current one');
}

/** The owner's DEKs now, offline (positive control and the content check). */
async function ownerDeks(c: Club) {
  const holder = await holderOf(c.ws, c.owner.id);
  const privateKey = await openHolder(holder, c.ownerPw);
  assert.ok(privateKey);
  return deksOf(holder, privateKey, await wrapRows(c.ws));
}

async function bodiesAt(c: Club, version: number) {
  const dek = (await ownerDeks(c)).get(version)!;
  const key = WorkspaceKey.fromDek(c.ws, version, dek);
  const rows = (await pool.query(`SELECT id::text, body FROM project_messages WHERE workspace_id = $1`, [c.ws])).rows as { id: string; body: string }[];
  const { openField } = await import('@flux/core');
  return rows.map((row) => openField((v) => (v === version ? key : undefined), { workspaceId: c.ws, field: 'project_messages.body', identity: [row.id] }, row.body));
}

describe('F-030 S2c key rotation (AC-13)', () => {
  test('removing an admin rotates to v2 and re-encrypts everything: Ben\'s password, DEK v1 and the old code open nothing in a later copy', async () => {
    const c = await club('Rotation club', ['Ben'], { Cy: 'member', Dee: 'guest' });
    const { texts, ids } = await seed(c, 12);
    const ben = c.people.Ben!;
    const kept = await keptBy(c.ws, ben.who.id, ben.pw!);
    assert.ok(opened(c.ws, kept.deks.get(1)!, await storedEnvelopes(c.ws)) > 10, 'positive control: before, DEK v1 opens the content');

    await removeMember(c.owner, c.ws, ben.who);
    const view = await readWorkspace(c.owner.browser, c.ws);
    assert.equal(view.encryption?.recoveryCode, false, 'the old code stops working at once');
    await settled(c.ws, 2);

    const adaHolder = await holderOf(c.ws, c.owner.id);
    assert.deepEqual((await events(c.ws, 'workspace.key_rotation_started.v1')).map((row) => row.holders), [[adaHolder.id]], 'the started event lists the holder set');
    assert.deepEqual(await events(c.ws, 'workspace.key_rotated.v1'), [{ version: 2 }]);
    await copyOpensNothing(c.ws, 2, [{ pw: ben.pw!, deks: kept.deks }], [c.recovery]);
    assert.equal(opened(c.ws, (await ownerDeks(c)).get(2)!, await storedEnvelopes(c.ws)), (await storedEnvelopes(c.ws)).length, 'positive control: DEK v2 opens all');

    // Ada reads every canary through the API.
    const project = expectStatus(await c.owner.browser.request('GET', `/api/v1/projects/${ids.project}`), 200) as { name: string };
    assert.equal(project.name, texts.project);
    const conversation = expectStatus(await c.owner.browser.request('GET', `/api/v1/conversations/${ids.conversation}`), 200) as { messages: { body: string }[] };
    assert.ok(conversation.messages.length > 0 && conversation.messages.every((m) => texts.messages.includes(m.body)));
    assert.deepEqual(new Set(await bodiesAt(c, 2)), new Set(texts.messages), 'every message exactly once, none lost');
    assert.equal((expectStatus(await c.owner.browser.request('GET', `/api/v1/decisions/${ids.decision}`), 200) as { title: string }).title, texts.decision);
    assert.equal((expectStatus(await c.owner.browser.request('GET', `/api/v1/drafts/${ids.draft}`), 200) as { title: string }).title, texts.draft);
    assert.deepEqual((expectStatus(await c.owner.browser.request('GET', `/api/v1/dms/${ids.dm}`), 200) as { messages: { body: string }[] }).messages.map((m) => m.body), [texts.dm]);
    const after = await readWorkspace(c.owner.browser, c.ws);
    assert.equal(after.encryption?.rotation, null);
    assert.ok(after.encryption?.keyChangedAt);

    // Ada has no confirmation of v2 and v1 is gone: her next unlock accepts v2 by its check value and a stored
    // envelope (S1 review carry-over), then confirms it.
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'the post-rotation unlock');
    assert.deepEqual((await holderOf(c.ws, c.owner.id) as HolderRow & { confirmed_versions: number[] }).confirmed_versions, [2]);
    const made = expectStatus(await c.owner.browser.request('POST', workspaceRecoveryCodePath(c.ws), { body: { password: c.ownerPw } }), 200) as { recoveryCode: string };
    secrets.add(made.recoveryCode);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    expectStatus(await unlock(c.people.Cy!.who.browser, c.ws, { recoveryCode: c.recovery }), 403, 'members cannot unlock');
    expectStatus(await unlock(c.owner.browser, c.ws, { recoveryCode: c.recovery }), 400, 'the old code');
    expectStatus(await unlock(c.owner.browser, c.ws, { recoveryCode: made.recoveryCode }), 200, 'a new code works');
  });

  test('a removal while locked is pending (no v2) until the first unlock, which starts the rotation', async () => {
    const c = await club('Locked removal club', ['Ben']);
    await seed(c, 4);
    const kept = await keptBy(c.ws, c.people.Ben!.who.id, c.people.Ben!.pw!);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    assert.deepEqual(await keysOf(c.ws), { current_version: 1, live_versions: [1], rotation: 'pending', tampered_at: null });
    assert.deepEqual((await readWorkspace(c.owner.browser, c.ws)).encryption?.rotation, { percent: 0, paused: true, startedAt: null, stalled: false });
    await sleep(1_500);
    assert.equal((await keysOf(c.ws)).current_version, 1, 'no new version while locked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_key_versions WHERE workspace_id = $1', [c.ws])).rows[0].n, 1);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200);
    await settled(c.ws, 2);
    await copyOpensNothing(c.ws, 2, [{ pw: c.people.Ben!.pw!, deks: kept.deks }], [c.recovery]);
  });

  test('a demotion, leaving and removing an owner without a password each rotate; removing a member does not', async () => {
    const c = await club('Roles club', ['Ben'], { Cy: 'member', Eve: 'admin', Ola: 'owner' });
    await seed(c, 2);
    await removeMember(c.owner, c.ws, c.people.Cy!.who);
    await sleep(1_500);
    assert.deepEqual(await keysOf(c.ws), { current_version: 1, live_versions: [1], rotation: 'none', tampered_at: null }, 'a member never held a key');
    expectStatus(await c.owner.browser.request('PATCH', `/api/v1/workspaces/${c.ws}/members/${c.people.Ben!.who.id}`, { body: { role: 'member' } }), 200);
    await settled(c.ws, 2);
    expectStatus(await c.people.Eve!.who.browser.request('DELETE', `/api/v1/workspaces/${c.ws}/members/${c.people.Eve!.who.id}`), 204, 'an admin without a password leaves');
    await settled(c.ws, 3);
    await removeMember(c.owner, c.ws, c.people.Ola!.who);
    await settled(c.ws, 4);
    const reasons = (await events(c.ws, 'workspace.key_rotated.v1')).map((row) => row.version);
    assert.deepEqual(reasons, [2, 3, 4]);
  });

  test('two removals in a row end at v3, and neither person\'s keys open the copy', async () => {
    const c = await club('Two removals club', ['Ben', 'Fay']);
    await seed(c, 150);
    const ben = await keptBy(c.ws, c.people.Ben!.who.id, c.people.Ben!.pw!);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    const during = await running(c.ws, 2);
    const fay = await keptBy(c.ws, c.people.Fay!.who.id, c.people.Fay!.pw!); // Fay received DEK v2 at the start
    assert.ok(fay.deks.has(2), 'the start sealed v2 to Fay');
    await removeMember(c.owner, c.ws, c.people.Fay!.who);
    assert.deepEqual(during.live_versions, [1, 2], 'the second removal came while v1 and v2 were live');
    await settled(c.ws, 3);
    await copyOpensNothing(c.ws, 3, [{ pw: c.people.Ben!.pw!, deks: ben.deks }, { pw: c.people.Fay!.pw!, deks: fay.deks }], [c.recovery]);
  });

  test('Lock now mid-rotation pauses it; unlock resumes; a changed commitment, a forged wrap against a confirmation and a deleted confirmation are tampering', async () => {
    const c = await club('Paused club', ['Ben'], { Cy: 'member' });
    await seed(c, 300);
    const ben = await keptBy(c.ws, c.people.Ben!.who.id, c.people.Ben!.pw!);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    await running(c.ws, 2);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    const view = (await readWorkspace(c.people.Cy!.who.browser, c.ws)).encryption!;
    assert.equal(view.state, 'locked');
    assert.equal(view.rotation?.paused, true);
    assert.ok(view.rotation?.startedAt);
    const progress = async () => (await pool.query('SELECT step, cursor, rows_done FROM workspace_rotation_progress WHERE workspace_id = $1', [c.ws])).rows[0];
    const frozen = await progress();
    await sleep(1_500);
    assert.deepEqual(await progress(), frozen, 'nothing moves while locked');
    assert.equal((await keysOf(c.ws)).rotation, 'reencrypting');

    const tamperedUnlock = async (label: string) => {
      const answer = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
      assert.equal(answer.status, 409, `${label}: ${answer.text}`);
      assert.equal(codeOf(answer), 'ENCRYPTION_TAMPERED');
      assert.equal(await unlockRowCount(c.ws), 0, `${label}: no unlock row`);
    };
    // (d) the v2 commitment changed: Ada has no confirmation of v2, so the chain decides, and fails.
    const [v2] = (await pool.query('SELECT commitment, check_value FROM workspace_key_versions WHERE workspace_id = $1 AND key_version = 2', [c.ws])).rows;
    await pool.query('UPDATE workspace_key_versions SET commitment = $2 WHERE workspace_id = $1 AND key_version = 2', [c.ws, randomBytes(32).toString('base64url')]);
    await tamperedUnlock('a changed commitment');
    assert.ok((await keysOf(c.ws)).tampered_at);
    await pool.query('UPDATE workspace_key_versions SET commitment = $2 WHERE workspace_id = $1 AND key_version = 2', [c.ws, v2.commitment]);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'repaired: unlocks');
    assert.equal((await keysOf(c.ws)).tampered_at, null, 'and clears the flag');
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    const adaHolder = await holderOf(c.ws, c.owner.id) as HolderRow & { confirmed_versions: number[]; holder_mac: string };
    const [adaWrap] = (await pool.query('SELECT * FROM workspace_dek_wraps WHERE holder_id = $1 AND key_version = $2', [adaHolder.id, (await keysOf(c.ws)).current_version])).rows;
    assert.ok(adaWrap.confirm, 'Ada confirmed the current version at that unlock');

    // (e) Ben (who knows DEK v1) replaces Ada's current wrap with an attacker DEK and forges a valid commitment and check
    // value for it: Ada's confirmation decides, so it is refused.
    const version = adaWrap.key_version as number;
    const attacker = newDek();
    const [kv] = (await pool.query('SELECT commitment, check_value FROM workspace_key_versions WHERE workspace_id = $1 AND key_version = $2', [c.ws, version])).rows;
    const box = sealDekToHolder(attacker, adaHolder.public_key, { workspaceId: c.ws, holderId: adaHolder.id, keyVersion: version });
    const forged = version === 2 ? keyCommitment(ben.deks.get(1)!, c.ws, 2, attacker) : kv.commitment;
    await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $2, sealed_dek = $3 WHERE holder_id = $1 AND key_version = $4', [adaHolder.id, box.ephemeralPublic, box.sealedDek, version]);
    await pool.query('UPDATE workspace_key_versions SET commitment = $3, check_value = $4 WHERE workspace_id = $1 AND key_version = $2',
      [c.ws, version, forged, keyCheckValue(WorkspaceKey.fromDek(c.ws, version, attacker))]);
    await tamperedUnlock('a forged wrap against a confirmation');
    await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $2, sealed_dek = $3 WHERE holder_id = $1 AND key_version = $4', [adaHolder.id, adaWrap.ephemeral_public, adaWrap.sealed_dek, version]);
    await pool.query('UPDATE workspace_key_versions SET commitment = $3, check_value = $4 WHERE workspace_id = $1 AND key_version = $2', [c.ws, version, kv.commitment, kv.check_value]);

    // (f) Ada's confirmation deleted: the MAC covers the confirmed set, so this is tampering, not a fall-back to the chain.
    await pool.query('UPDATE workspace_dek_wraps SET confirm = NULL WHERE holder_id = $1 AND key_version = $2', [adaHolder.id, version]);
    await tamperedUnlock('a deleted confirmation');
    await pool.query('UPDATE workspace_dek_wraps SET confirm = $3 WHERE holder_id = $1 AND key_version = $2', [adaHolder.id, version, adaWrap.confirm]);

    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'repaired again: unlocks, and the rotation resumes');
    await settled(c.ws, 2);
    await copyOpensNothing(c.ws, 2, [{ pw: c.people.Ben!.pw!, deks: ben.deks }], [c.recovery]);
  });

  test('during a rotation: a new admin\'s password opens both versions, and concurrent writes keep their newest content', async () => {
    const c = await club('Busy club', ['Ben'], { Hal: 'admin' });
    await seed(c, 300);
    const project = (await pool.query('SELECT id FROM projects WHERE workspace_id = $1', [c.ws])).rows[0].id as string;
    const conversation = (await pool.query('SELECT id FROM project_conversations WHERE project_id = $1', [project])).rows[0].id as string;
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    await running(c.ws, 2);
    const written: string[] = [];
    let stop = false;
    // Three writers back to back (S2c review P2-1): the fair key gate keeps the start, the finish and Hal's password from
    // starving behind them, and the rotation's pages skip a row a writer holds instead of waiting for it.
    const writers = Array.from({ length: 3 }, () => (async () => {
      while (!stop) {
        const body = `during-${randomUUID()}`;
        const answer = await c.owner.browser.request('POST', `/api/v1/conversations/${conversation}/messages`, { body: { body, clientMessageId: randomUUID() }, headers: key() });
        assert.equal(answer.status, 201, answer.text);
        written.push(body);
      }
    })());
    const started = Date.now();
    try {
    const hal = c.people.Hal!;
    hal.pw = passphrase();
    secrets.add(hal.pw);
    expectStatus(await c.owner.browser.request('POST', workspaceUnlockGrantsPath(c.ws), { body: { userId: hal.who.id, password: c.ownerPw } }), 201);
    expectStatus(await hal.who.browser.request('PUT', workspaceUnlockPasswordPath(c.ws), { body: { newPassword: hal.pw } }), 200);
    const [seen] = (await pool.query(`SELECT k.live_versions, array(SELECT key_version FROM workspace_dek_wraps w JOIN workspace_holders h ON h.id = w.holder_id
      WHERE h.workspace_id = k.workspace_id AND h.user_id = $2 AND w.confirm IS NOT NULL ORDER BY 1) AS hal FROM workspace_keys k WHERE k.workspace_id = $1`, [c.ws, hal.who.id])).rows;
    assert.deepEqual(seen.hal, seen.live_versions, 'Hal has a confirmed wrap of every live version');
    assert.deepEqual(seen.live_versions, [1, 2], 'set while v1 and v2 were live');
    await settled(c.ws, 2);
    assert.ok(Date.now() - started < 60_000, `the rotation finished under sustained writes in ${Date.now() - started} ms`);
    } finally {
      stop = true;
      await Promise.allSettled(writers);
    }
    await Promise.all(writers);
    assert.ok(written.length > 0);
    const bodies = new Set(await bodiesAt(c, 2));
    assert.deepEqual(written.filter((body) => !bodies.has(body)), [], 'every write during the rotation is there, at v2');
    expectStatus(await lock(c.people.Hal!.who.browser, c.ws), 200);
    expectStatus(await unlock(c.people.Hal!.who.browser, c.ws, { password: c.people.Hal!.pw! }), 200, 'Hal unlocks after the finish');
  });

  test('a writer holding workspace_keys FOR SHARE across a removal commits before the start; its v1 value is re-encrypted', async () => {
    const c = await club('Held writer club', ['Ben']);
    const { ids } = await seed(c, 2);
    const dek1 = (await ownerDeks(c)).get(1)!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT current_version FROM workspace_keys WHERE workspace_id = $1 FOR SHARE', [c.ws]);
      const removal = removeMember(c.owner, c.ws, c.people.Ben!.who);
      await sleep(800);
      assert.deepEqual(await keysOf(c.ws), { current_version: 1, live_versions: [1], rotation: 'none', tampered_at: null }, 'the role change waits for the writer');
      const value = sealField(WorkspaceKey.fromDek(c.ws, 1, dek1), { workspaceId: c.ws, field: 'projects.name', identity: [ids.project] }, 'Held across the start');
      await client.query('UPDATE projects SET name = $2 WHERE id = $1', [ids.project, value]);
      await client.query('COMMIT');
      await removal;
    } finally { client.release(); }
    await settled(c.ws, 2);
    const [row] = (await pool.query('SELECT name FROM projects WHERE id = $1', [ids.project])).rows;
    assert.match(row.name, /^fx1\.2\./);
    assert.equal((expectStatus(await c.owner.browser.request('GET', `/api/v1/projects/${ids.project}`), 200) as { name: string }).name, 'Held across the start');
  });

  test('tampering with direct SQL writes and no key: each refuses the unlock, no DEK is sealed to an attacker key; repaired, it unlocks and rotates', async () => {
    const c = await club('Tamper rotation club', ['Ben'], { Cy: 'member' });
    await seed(c, 3);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    assert.equal((await keysOf(c.ws)).rotation, 'pending');
    const [ada] = (await pool.query(`SELECT * FROM workspace_holders WHERE workspace_id = $1 AND kind = 'password'`, [c.ws])).rows;
    const refused = async (label: string) => {
      const answer = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
      assert.equal(answer.status, 409, `${label}: ${answer.text}`);
      assert.equal(codeOf(answer), 'ENCRYPTION_TAMPERED');
      assert.equal(await unlockRowCount(c.ws), 0);
      assert.equal((await keysOf(c.ws)).current_version, 1, `${label}: no new version`);
    };
    // (a) Ada's public key replaced by an attacker's.
    const attacker = generateHolderKeyPair();
    await pool.query('UPDATE workspace_holders SET public_key = $2 WHERE id = $1', [ada.id, attacker.publicKey]);
    await refused('a replaced public key');
    await pool.query('UPDATE workspace_holders SET public_key = $2 WHERE id = $1', [ada.id, ada.public_key]);
    // (b) a rogue password holder for the member Cy, with the attacker's key and a copied MAC.
    const rogue = randomUUID();
    await pool.query(`INSERT INTO workspace_holders (id, workspace_id, kind, user_id, kdf, public_key, wrapped_private, holder_mac, holder_mac_version, secret_check)
      VALUES ($1, $2, 'password', $3, $4, $5, $6, $7, 1, $8)`, [rogue, c.ws, c.people.Cy!.who.id, ada.kdf, attacker.publicKey, ada.wrapped_private, ada.holder_mac, ada.secret_check]);
    await refused('a rogue holder for a member');
    await pool.query('DELETE FROM workspace_holders WHERE id = $1', [rogue]); // leaves a tombstone; the rotation stays pending
    // (c) every holder's v1 wrap replaced by a box to the real public key carrying an attacker DEK.
    const wraps = (await pool.query('SELECT * FROM workspace_dek_wraps WHERE workspace_id = $1', [c.ws])).rows;
    const evil = newDek();
    for (const wrap of wraps) {
      const [holder] = (await pool.query('SELECT public_key FROM workspace_holders WHERE id = $1', [wrap.holder_id])).rows;
      const box = sealDekToHolder(evil, holder.public_key, { workspaceId: c.ws, holderId: wrap.holder_id, keyVersion: wrap.key_version });
      await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $3, sealed_dek = $4 WHERE holder_id = $1 AND key_version = $2', [wrap.holder_id, wrap.key_version, box.ephemeralPublic, box.sealedDek]);
    }
    await refused('every wrap carrying an attacker DEK');
    for (const wrap of wraps) {
      await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $3, sealed_dek = $4 WHERE holder_id = $1 AND key_version = $2', [wrap.holder_id, wrap.key_version, wrap.ephemeral_public, wrap.sealed_dek]);
    }
    // (d) the v1 check value changed.
    const [v1] = (await pool.query('SELECT check_value FROM workspace_key_versions WHERE workspace_id = $1 AND key_version = 1', [c.ws])).rows;
    await pool.query('UPDATE workspace_key_versions SET check_value = $2 WHERE workspace_id = $1 AND key_version = 1', [c.ws, keyCheckValue(WorkspaceKey.fromDek(c.ws, 1, evil))]);
    await refused('a changed check value');
    await pool.query('UPDATE workspace_key_versions SET check_value = $2 WHERE workspace_id = $1 AND key_version = 1', [c.ws, v1.check_value]);
    assert.ok((await keysOf(c.ws)).tampered_at);

    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'repaired');
    assert.equal((await keysOf(c.ws)).tampered_at, null);
    await settled(c.ws, 2);
    const all = await wrapRows(c.ws);
    assert.equal(all.filter((row) => row.holder_id === rogue).length, 0, 'nothing was ever sealed to the rogue holder');
    assert.equal(deksOf({ id: rogue, workspace_id: c.ws }, attacker.privateKey, all).size, 0, 'the attacker key opens no wrap');
    const holders = await holderRows(c.ws);
    for (const holder of holders) assert.equal(deksOf({ id: holder.id, workspace_id: c.ws }, attacker.privateKey, all).size, 0);
  });

  test('a restored old holder row with its tombstone is not sealed to; the started event lists the holder set; its stale MAC then locks the space', async () => {
    const c = await club('Restored row club', ['Ben']);
    await seed(c, 3);
    const ben = c.people.Ben!;
    const [row] = (await pool.query('SELECT * FROM workspace_holders WHERE workspace_id = $1 AND user_id = $2', [c.ws, ben.who.id])).rows;
    const wraps = (await pool.query('SELECT * FROM workspace_dek_wraps WHERE holder_id = $1', [row.id])).rows;
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    await removeMember(c.owner, c.ws, ben.who);
    // Ben, who can write to the database, restores his membership, his holder row and his wraps; the tombstone stays.
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role, created_by) VALUES ($1, $2, 'admin', $3)`, [c.ws, ben.who.id, c.owner.id]);
    await pool.query(`INSERT INTO workspace_holders (id, workspace_id, kind, user_id, kdf, public_key, wrapped_private, holder_mac, holder_mac_version, secret_check, confirmed_versions, pin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [row.id, c.ws, row.kind, row.user_id, row.kdf, row.public_key, row.wrapped_private, row.holder_mac,
      row.holder_mac_version, row.secret_check, row.confirmed_versions, row.pin]);
    for (const wrap of wraps) {
      await pool.query(`INSERT INTO workspace_dek_wraps (holder_id, workspace_id, key_version, ephemeral_public, sealed_dek, confirm) VALUES ($1, $2, $3, $4, $5, $6)`,
        [wrap.holder_id, wrap.workspace_id, wrap.key_version, wrap.ephemeral_public, wrap.sealed_dek, wrap.confirm]);
    }
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'the restored row still verifies at v1');
    await settled(c.ws, 2);
    const started = await events(c.ws, 'workspace.key_rotation_started.v1');
    const adaHolder = await holderOf(c.ws, c.owner.id);
    assert.deepEqual(started.map((e) => e.holders), [[adaHolder.id]], 'Ben\'s restored row is not in the holder set');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_dek_wraps WHERE holder_id = $1', [row.id])).rows[0].n, 0, 'no wrap of v2 for Ben');
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    const answer = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
    assert.equal(answer.status, 409, 'the restored row\'s MAC is of v1: its presence locks the space instead of being skipped');
    assert.equal(codeOf(answer), 'ENCRYPTION_TAMPERED');
  });

  test('cascades: an account deletion leads to a rotation; a holder deleted during reencrypting leads to n+2; the last password and a version without commitment are refused', async () => {
    const c = await club('Cascade club', ['Ben', 'Fay']);
    await seed(c, 150);
    await pool.query('DELETE FROM workspace_holders WHERE workspace_id = $1 AND user_id = $2', [c.ws, c.people.Ben!.who.id]); // a holder deleted by cascade
    assert.equal((await keysOf(c.ws)).rotation === 'pending' || (await keysOf(c.ws)).current_version === 2, true);
    await running(c.ws, 2);
    await pool.query('DELETE FROM auth_users WHERE id = $1', [c.people.Fay!.who.id]); // an account deletion cascading to a holder, mid-rotation
    await settled(c.ws, 3);
    await assert.rejects(pool.query(`DELETE FROM workspace_holders WHERE workspace_id = $1 AND kind = 'password'`, [c.ws]), { hint: 'LAST_UNLOCK_PASSWORD' });
    await assert.rejects(pool.query(`INSERT INTO workspace_key_versions (workspace_id, key_version, commitment, check_value) VALUES ($1, 9, NULL, 'x')`, [c.ws]), { code: '23514' });
  });
});

describe('F-030 S2c confirmed set covered by every holder MAC', () => {
  test('another holder\'s deleted confirmation makes the unlock refuse; restored, it unlocks', async () => {
    const c = await club('Confirm club', ['Ben']);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    const ben = await holderOf(c.ws, c.people.Ben!.who.id);
    const [wrap] = (await pool.query('SELECT confirm FROM workspace_dek_wraps WHERE holder_id = $1 AND key_version = 1', [ben.id])).rows;
    assert.ok(wrap.confirm);
    await pool.query('UPDATE workspace_dek_wraps SET confirm = NULL WHERE holder_id = $1 AND key_version = 1', [ben.id]);
    const answer = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
    assert.equal(answer.status, 409, `Ada's own wraps are intact; Ben's MAC lists a confirmation that is gone: ${answer.text}`);
    assert.equal(codeOf(answer), 'ENCRYPTION_TAMPERED');
    await pool.query('UPDATE workspace_dek_wraps SET confirm = $2 WHERE holder_id = $1 AND key_version = 1', [ben.id, wrap.confirm]);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200);
  });
});

async function upload(who: Person, projectId: string, name: string, body: Buffer | ReadableStream) {
  const url = new URL(`/api/v1/projects/${projectId}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(name)}`, who.browser.base);
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: who.browser.cookieHeader(), origin: who.browser.defaultOrigin }, body: body as never };
  if (!(body instanceof Buffer)) init.duplex = 'half';
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })(), text };
}
const download = async (who: Person, fileId: string) => {
  const response = await fetch(new URL(`/api/v1/files/${fileId}`, who.browser.base), { headers: { cookie: who.browser.cookieHeader() } });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
};

/** Every row of the workspace, in every table (not only the registry), that still holds an envelope below `version`. */
async function anywhereBelow(ws: string, version: number): Promise<string[]> {
  const tables = (await pool.query(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'workspace_id'
    AND table_name NOT IN ('workspace_key_versions')`)).rows.map((row) => row.t as string);
  const hits: string[] = [];
  for (const table of tables) {
    const rows = (await pool.query(`SELECT row_to_json(t)::text AS j FROM ${table} t WHERE workspace_id = $1`, [ws])).rows as { j: string }[];
    for (const row of rows) for (const match of row.j.matchAll(/fx1\.(\d+)\./g)) if (Number(match[1]) < version) hits.push(table);
  }
  return [...new Set(hits)];
}

describe('F-030 S2c review fixes', () => {
  test('files: a stored file is re-encrypted; an upload that straddles the whole rotation is refused, never stored under the old key', async () => {
    const c = await club('Files rotation club', ['Ben']);
    const project = expectStatus(await c.owner.browser.request('POST', `/api/v1/workspaces/${c.ws}/projects`, { body: { name: 'Files', visibility: 'workspace' }, headers: key() }), 201) as { id: string };
    const before = Buffer.from('file before the rotation '.repeat(500));
    const stored = await upload(c.owner, project.id, 'before.txt', before);
    assert.equal(stored.status, 201, stored.text);
    const fileId = String(stored.json!.id);
    const kept = await keptBy(c.ws, c.people.Ben!.who.id, c.people.Ben!.pw!);
    assert.equal(filesOpened(c.ws, kept.deks.get(1)!, await fileObjects(c.ws)), 1, 'positive control: before, DEK v1 opens the object');

    const body = Buffer.from('straddling upload '.repeat(2000));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stream = Readable.toWeb(Readable.from((async function* () { yield body.subarray(0, 8000); await gate; yield body.subarray(8000); })())) as unknown as ReadableStream;
    const pending = upload(c.owner, project.id, 'straddle.txt', stream);
    await waitFor('the upload is receiving under v1', async () => (await pool.query(`SELECT 1 FROM project_files WHERE workspace_id = $1 AND state = 'receiving' AND key_version = 1`, [c.ws])).rows.length > 0);
    await sleep(500);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    await settled(c.ws, 2);
    release();
    const straddled = await pending;
    assert.equal(straddled.status, 409, `the object is sealed under a version the finish dropped: ${straddled.text}`);
    assert.equal(codeOf({ json: straddled.json } as never), 'UPLOAD_KEY_CHANGED');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM project_files WHERE workspace_id = $1 AND id <> $2`, [c.ws, fileId])).rows[0].n, 0, 'no row of it is kept');
    const row = (await pool.query('SELECT key_version FROM project_files WHERE id = $1', [fileId])).rows[0];
    assert.equal(row.key_version, 2);
    const got = await download(c.owner, fileId);
    assert.equal(got.status, 200);
    assert.ok(got.bytes.equals(before), 'the re-encrypted file downloads unchanged');
    await copyOpensNothing(c.ws, 2, [{ pw: c.people.Ben!.pw!, deks: kept.deks }], [c.recovery]);
    const again = await upload(c.owner, project.id, 'again.txt', body);
    assert.equal(again.status, 201, 'sent again, it is stored under v2');
  });

  test('copies outside the registry: a notification copy is made content-free at the finish; any other copy blocks the finish and is reported', async () => {
    const c = await club('Copies club', ['Ben'], { Cy: 'member' });
    const { ids } = await seed(c, 2);
    expectStatus(await c.owner.browser.request('POST', `/api/v1/projects/${ids.project}/work`, { body: { title: `canary-task-${randomUUID()}`, owner: { kind: 'human', id: c.people.Cy!.who.id } }, headers: key() }), 201);
    await waitFor('the assignment notification', async () => (await pool.query(`SELECT 1 FROM notifications WHERE workspace_id = $1 AND user_id = $2`, [c.ws, c.people.Cy!.who.id])).rows.length > 0);
    // A copy in an unregistered place (as a database writer or a future bug would make it): a v1 envelope in a job payload.
    const [project] = (await pool.query('SELECT name FROM projects WHERE id = $1', [ids.project])).rows;
    const wait = randomUUID();
    await pool.query(`INSERT INTO sealed_job_waits (id, workspace_id, queue, payload) VALUES ($1, $2, 'test', $3::jsonb)`, [wait, c.ws, JSON.stringify({ copy: project.name })]);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    const stalled = await waitFor('the rotation reports it cannot finish', async () =>
      (await pool.query('SELECT stalled_on FROM workspace_rotation_progress WHERE workspace_id = $1', [c.ws])).rows[0]?.stalled_on as string | undefined);
    assert.equal(stalled, 'sealed_job_waits.payload');
    assert.equal((await readWorkspace(c.owner.browser, c.ws)).encryption?.rotation?.stalled, true);
    assert.ok((await pool.query(`SELECT 1 FROM notifications WHERE workspace_id = $1 AND reason = 'security' AND title LIKE '%cannot finish%'`, [c.ws])).rows.length > 0, 'holders are told');
    assert.ok((await keysOf(c.ws)).live_versions.includes(1), 'v1 is kept while a copy needs it');
    await pool.query('DELETE FROM sealed_job_waits WHERE id = $1', [wait]);
    await settled(c.ws, 2);
    assert.deepEqual(await anywhereBelow(c.ws, 2), [], 'no table holds an envelope below v2 for the workspace');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1 AND (title LIKE '%fx1.%' OR body LIKE '%fx1.%')`, [c.ws])).rows[0].n, 0,
      'notification copies are content-free');
  });

  test('the key pin: a recovery holder planted while locked and a key version forged after the finish are refused; nothing is sealed to the planted key', async () => {
    const c = await club('Pin club', ['Ben']);
    await seed(c, 3);
    const ben = await keptBy(c.ws, c.people.Ben!.who.id, c.people.Ben!.pw!);
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    // Ben, who knows DEK v1 and writes to the database, plants a recovery holder of his own with a valid MAC under v1.
    const rogue = randomUUID();
    const pair = generateHolderKeyPair();
    const kek = randomBytes(32);
    const kdf = newKdfParams();
    const who = { workspaceId: c.ws, holderId: rogue, kind: 'recovery' as const, userId: null };
    const wrappedPrivate = wrapPrivateKey(kek, pair, who);
    const secretCheck = holderSecretCheck(kek, who);
    const mac = holderMac(ben.deks.get(1)!, 1, { ...who, publicKey: pair.publicKey, kdf, wrappedPrivate, secretCheck, confirmedVersions: [] });
    await pool.query(`INSERT INTO workspace_holders (id, workspace_id, kind, user_id, kdf, public_key, wrapped_private, holder_mac, holder_mac_version, secret_check, confirmed_versions)
      VALUES ($1, $2, 'recovery', NULL, $3::jsonb, $4, $5, $6, 1, $7, '{}')`, [rogue, c.ws, JSON.stringify(kdf), pair.publicKey, wrappedPrivate, mac, secretCheck]);
    const refused = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(codeOf(refused), 'ENCRYPTION_TAMPERED');
    await sleep(1_000);
    assert.equal((await keysOf(c.ws)).current_version, 1, 'no rotation started');
    await pool.query('DELETE FROM workspace_holders WHERE id = $1', [rogue]);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'removed again, it unlocks');
    await settled(c.ws, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_dek_wraps WHERE holder_id = $1', [rogue])).rows[0].n, 0);

    // After the finish Ada has no confirmation of v2. A database writer forges v2 for her: a DEK of their own in her wrap,
    // a matching check value, commitment, MAC and sampled envelope. The version pin refuses it.
    expectStatus(await lock(c.owner.browser, c.ws), 200);
    const ada = await holderOf(c.ws, c.owner.id) as HolderRow & { holder_mac: string; confirmed_versions: number[]; pin: string };
    const [wrap] = (await pool.query('SELECT * FROM workspace_dek_wraps WHERE holder_id = $1 AND key_version = 2', [ada.id])).rows;
    assert.equal(wrap.confirm, null, 'Ada has not confirmed v2 yet');
    const [kv] = (await pool.query('SELECT check_value, commitment FROM workspace_key_versions WHERE workspace_id = $1 AND key_version = 2', [c.ws])).rows;
    const evil = newDek();
    const evilKey = WorkspaceKey.fromDek(c.ws, 2, evil);
    const box = sealDekToHolder(evil, ada.public_key, { workspaceId: c.ws, holderId: ada.id, keyVersion: 2 });
    await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $2, sealed_dek = $3 WHERE holder_id = $1 AND key_version = 2', [ada.id, box.ephemeralPublic, box.sealedDek]);
    await pool.query('UPDATE workspace_key_versions SET check_value = $2 WHERE workspace_id = $1 AND key_version = 2', [c.ws, keyCheckValue(evilKey)]);
    await pool.query('UPDATE workspace_holders SET holder_mac = $2 WHERE id = $1', [ada.id, holderMac(evil, 2, {
      workspaceId: c.ws, holderId: ada.id, kind: 'password', userId: c.owner.id, publicKey: ada.public_key, kdf: ada.kdf, wrappedPrivate: ada.wrapped_private,
      secretCheck: ada.secret_check, confirmedVersions: ada.confirmed_versions })]);
    const [sample] = (await pool.query(`SELECT id::text FROM projects WHERE workspace_id = $1 LIMIT 1`, [c.ws])).rows;
    const [sampleRow] = (await pool.query('SELECT name FROM projects WHERE id = $1', [sample.id])).rows;
    await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [sample.id, sealField(evilKey, { workspaceId: c.ws, field: 'projects.name', identity: [sample.id] }, 'forged')]);
    const forged = await unlock(c.owner.browser, c.ws, { password: c.ownerPw });
    assert.equal(forged.status, 409, `a forged key version is refused: ${forged.text}`);
    assert.equal(codeOf(forged), 'ENCRYPTION_TAMPERED');
    assert.equal(await unlockRowCount(c.ws), 0);
    await pool.query('UPDATE workspace_dek_wraps SET ephemeral_public = $2, sealed_dek = $3 WHERE holder_id = $1 AND key_version = 2', [ada.id, wrap.ephemeral_public, wrap.sealed_dek]);
    await pool.query('UPDATE workspace_key_versions SET check_value = $2, commitment = $3 WHERE workspace_id = $1 AND key_version = 2', [c.ws, kv.check_value, kv.commitment]);
    await pool.query('UPDATE workspace_holders SET holder_mac = $2 WHERE id = $1', [ada.id, ada.holder_mac]);
    await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [sample.id, sampleRow.name]);
    expectStatus(await unlock(c.owner.browser, c.ws, { password: c.ownerPw }), 200, 'repaired, it unlocks');
  });

  test('an old-version value that does not open stalls the rotation visibly; removed, the rotation finishes', async () => {
    const c = await club('Stuck club', ['Ben']);
    const { ids } = await seed(c, 2);
    const [row] = (await pool.query('SELECT name FROM projects WHERE id = $1', [ids.project])).rows;
    // A value that names v1 but does not open (planted by a database writer, or damaged).
    await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [ids.project, `fx1.1.${randomBytes(48).toString('base64url')}`]);
    await removeMember(c.owner, c.ws, c.people.Ben!.who);
    const on = await waitFor('stalled', async () => (await pool.query('SELECT stalled_on FROM workspace_rotation_progress WHERE workspace_id = $1', [c.ws])).rows[0]?.stalled_on as string | undefined);
    assert.equal(on, 'projects.name');
    assert.equal((await readWorkspace(c.owner.browser, c.ws)).encryption?.rotation?.stalled, true);
    await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [ids.project, row.name]);
    await settled(c.ws, 2);
  });
});

describe('F-030 S2c files step', () => {
  test('a file object is re-encrypted by a new object and a rename; a crash between the rename and the row update only updates the row', async () => {
    const ws = randomUUID();
    const file = randomUUID();
    const v1 = WorkspaceKey.fromDek(ws, 1, newDek());
    const v2 = WorkspaceKey.fromDek(ws, 2, newDek());
    const seal = realSeal(ws, 2, new Map([[1, v1], [2, v2]]));
    const plain = randomBytes(70_000);
    const { sealFileObject, fileObjectVersion } = await import('@flux/core');
    const store = new Map<string, Buffer>([[file, sealFileObject(v1, file, plain)]]);
    const objects: RotationFileObjects = { read: async (id) => store.get(id) ?? null, replace: async (id, bytes) => { store.set(id, bytes); } };
    let row = 1;
    const setVersion = async (_id: string, from: number, to: number) => { if (row !== from) return false; row = to; return true; };
    await assert.rejects(rotateFileObject(seal, objects, { id: file, keyVersion: 1 }, 2, setVersion, async () => { throw new Error('crash'); }));
    assert.equal(fileObjectVersion(store.get(file)!), 2, 'the rename happened');
    assert.equal(row, 1, 'the row update did not');
    let rewrites = 0;
    const counting: RotationFileObjects = { read: objects.read, replace: async (id, bytes) => { rewrites += 1; await objects.replace(id, bytes); } };
    assert.equal(await rotateFileObject(seal, counting, { id: file, keyVersion: 1 }, 2, setVersion), true);
    assert.equal(rewrites, 0, 'the resumed step reads the header and only updates the row');
    assert.equal(row, 2);
    assert.ok(seal.fileCipher(file)!.open(store.get(file)!).equals(plain));
    assert.throws(() => realSeal(ws, 1, new Map([[1, v1]])).fileCipher(file)!.open(store.get(file)!), 'v1 alone opens nothing');
  });
});

test('rotation secrets join the log scan', async () => {
  const state = process.env.FLUX_TEST_STATE_DIR ?? '/state';
  await writeFile(join(state, 'rotation-secrets.txt'), [...secrets].join('\n') + '\n');
});
