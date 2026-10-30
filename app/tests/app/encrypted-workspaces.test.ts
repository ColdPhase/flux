import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { ENCRYPTED_WORKSPACES_PATH, workspaceRecoveryCodePath, workspaceUnlockGrantsPath, workspaceUnlockPasswordPath } from '@flux/contracts';
import { createEncryptionUseCases, type EncryptionUseCaseDeps } from '@flux/core';
import { pool } from './support/db.js';
import { codeOf, contentCall, createSealed, fixtureBearer, lock, passphrase, readWorkspace, unlock } from './support/encryption.js';
import { addMember, expectStatus, person, workspace, type Person } from './support/people.js';

// AC-2 of F-030 (#655, S1; docs/product/encrypted-workspaces.md#tests-and-acceptance-criteria): the lock lifecycle of an
// encrypted workspace A (fixture-created) against the plain workspace B as the control: creation and its retry, unlock,
// the shared password limiter, grants and first passwords, password changes, the recovery code, demotion, Lock now and
// the 423 that follows, tampering of key rows, and AI forced off.

let ada: Person; let ben: Person; let cy: Person; let dee: Person; let eve: Person; let fay: Person;
let A: string; let B: string; let recovery: string;
const pw = { ada: passphrase(), ben: passphrase(), eve: passphrase() };

const put = (who: Person, ws: string, body: Record<string, unknown>) => who.browser.request('PUT', workspaceUnlockPasswordPath(ws), { body });
const grant = (who: Person, ws: string, userId: string, password: string) => who.browser.request('POST', workspaceUnlockGrantsPath(ws), { body: { userId, password } });
const newCode = (who: Person, ws: string, password: string) => who.browser.request('POST', workspaceRecoveryCodePath(ws), { body: { password } });
const clearAttempts = (ws: string) => pool.query('DELETE FROM password_attempts WHERE workspace_id = $1', [ws]);
const events = async (ws: string, kind: string) => (await pool.query('SELECT data FROM events WHERE workspace_id = $1 AND kind = $2 ORDER BY seq', [ws, kind])).rows
  .map((row) => row.data as Record<string, unknown>);

before(async () => {
  [ada, ben, cy, dee, eve, fay] = [await person('Ada'), await person('Ben'), await person('Cy'), await person('Dee'), await person('Eve'), await person('Fay')];
  const created = await createSealed(ada, 'Garden club', pw.ada);
  A = created.workspace.id;
  recovery = created.recoveryCode;
  B = (await workspace(ada, 'Book club')).id;
  for (const ws of [A, B]) {
    await addMember(ada, ws, ben, 'admin');
    await addMember(ada, ws, cy, 'member');
    await addMember(ada, ws, dee, 'guest');
  }
});

describe('F-030 creation (fixture route)', () => {
  test('the creator gets a password, the space a recovery code shown once; AI is off and fixed; a retry has no code', async () => {
    const view = await readWorkspace(ada.browser, A);
    assert.equal(view.encryption?.state, 'unlocked');
    assert.equal(view.encryption?.myPassword, true);
    assert.equal(view.encryption?.canUnlock, true);
    assert.equal(view.encryption?.recoveryCode, true);
    assert.equal(view.encryption?.unlockedBy?.id, ada.id);
    assert.deepEqual({ state: view.ai.state, fixed: view.ai.fixed }, { state: 'blocked', fixed: 'encrypted' });
    assert.match(recovery, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const plain = await readWorkspace(ada.browser, B);
    assert.equal(plain.encryption, null);
    assert.equal(plain.ai.fixed, null);
    assert.equal((await readWorkspace(cy.browser, A)).encryption?.myPassword, false, 'members get false');

    const creationId = randomUUID();
    const first = await createSealed(eve, 'Retry club', pw.eve, creationId);
    const again = await eve.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'Retry club', creationId, password: pw.eve }, headers: fixtureBearer() });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual({ id: (again.json as { workspace: { id: string } }).workspace.id, code: (again.json as { recoveryCode: unknown }).recoveryCode },
      { id: first.workspace.id, code: null });
    const renamed = await eve.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'Other club', creationId, password: pw.eve }, headers: fixtureBearer() });
    assert.equal(renamed.status, 409);
    assert.equal(codeOf(renamed), 'IDEMPOTENCY_CONFLICT');
    assert.equal(again.headers.get('cache-control'), 'no-store');
  });

  test('creation needs the fixture bearer as well as a session', async () => {
    const response = await eve.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'No bearer club', creationId: randomUUID(), password: pw.eve } });
    assert.equal(response.status, 401);
    const wrong = await eve.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'No bearer club', creationId: randomUUID(), password: pw.eve },
      headers: { authorization: 'Bearer not-the-fixture-token' } });
    assert.equal(wrong.status, 401);
  });

  test('own passwords: under 20 characters and "abcdefghabcdefghabcd" are too weak', async () => {
    for (const password of ['short but sweet', 'abcdefghabcdefghabcd']) {
      const response = await eve.browser.request('POST', ENCRYPTED_WORKSPACES_PATH, { body: { name: 'Weak club', creationId: randomUUID(), password }, headers: fixtureBearer() });
      assert.equal(response.status, 400, password);
      assert.equal(codeOf(response), 'PASSWORD_TOO_WEAK');
    }
  });

  test('nothing secret reaches the database: no password, code or key in any key row', async () => {
    const rows = JSON.stringify((await pool.query(`SELECT (SELECT json_agg(h) FROM workspace_holders h WHERE workspace_id = $1) AS holders,
      (SELECT json_agg(w) FROM workspace_dek_wraps w WHERE workspace_id = $1) AS wraps, (SELECT json_agg(u) FROM workspace_unlocks u WHERE workspace_id = $1) AS unlocks,
      (SELECT json_agg(v) FROM workspace_key_versions v WHERE workspace_id = $1) AS versions`, [A])).rows);
    for (const secret of [pw.ada, recovery, recovery.replace(/-/g, '')]) assert.equal(rows.includes(secret), false);
    const holders = (await pool.query(`SELECT kind, user_id FROM workspace_holders WHERE workspace_id = $1 ORDER BY kind`, [A])).rows;
    assert.deepEqual(holders, [{ kind: 'password', user_id: ada.id }, { kind: 'recovery', user_id: null }]);
    const wraps = (await pool.query(`SELECT count(*)::int AS n, count(confirm)::int AS confirmed FROM workspace_dek_wraps WHERE workspace_id = $1`, [A])).rows[0];
    assert.deepEqual(wraps, { n: 2, confirmed: 2 }, 'v1 sealed to both holders, each with its confirmation');
  });
});

describe('F-030 unlock, Lock now and 423', () => {
  test('Lock now gives 423 on the next content call; B is unaffected; the right password unlocks; a repeat is not checked', async () => {
    expectStatus(await contentCall(ada.browser, A), 200);
    const locked = await lock(ben.browser, A);
    assert.equal(locked.status, 200, locked.text);
    assert.equal((locked.json as { encryption: { state: string } }).encryption.state, 'locked');
    assert.deepEqual((await events(A, 'workspace.locked.v1')).at(-1), { reason: 'person' });
    const refused = await contentCall(cy.browser, A);
    assert.equal(refused.status, 423, refused.text);
    assert.deepEqual(refused.json, { code: 'WORKSPACE_LOCKED', error: 'Garden club is waiting to be unlocked.', message: 'Garden club is waiting to be unlocked.',
      details: { workspaceId: A } });
    expectStatus(await contentCall(cy.browser, B), 200);
    assert.equal((await readWorkspace(cy.browser, A)).encryption?.state, 'locked', 'metadata still reads while locked');
    const outsider = await person('Outsider');
    assert.equal((await contentCall(outsider.browser, A)).status, 404, 'a non-member learns nothing');
    // S1 stopgap for cross-workspace reads (S2a filters them): refused for a member of the locked space, not for others.
    const inbox = await cy.browser.request('GET', '/api/v1/inbox');
    assert.equal(inbox.status, 423, inbox.text);
    assert.equal((await cy.browser.request('GET', '/api/v1/search?q=garden')).status, 423);
    assert.equal((await outsider.browser.request('GET', '/api/v1/inbox')).status, 200);

    const wrong = await unlock(ada.browser, A, { password: `${pw.ada} nope` });
    assert.equal(wrong.status, 400);
    assert.equal(codeOf(wrong), 'UNLOCK_INCORRECT');
    const right = await unlock(ada.browser, A, { password: pw.ada });
    assert.equal(right.status, 200, right.text);
    assert.equal((right.json as { encryption: { state: string } }).encryption.state, 'unlocked');
    assert.deepEqual((await events(A, 'workspace.unlocked.v1')).at(-1), { by: ada.id });
    expectStatus(await contentCall(cy.browser, A), 200);
    expectStatus(await cy.browser.request('GET', '/api/v1/inbox'), 200);
    const repeat = await unlock(ada.browser, A, { password: 'not checked while unlocked' });
    assert.equal(repeat.status, 200, 'already unlocked: no check, so no oracle');
    await clearAttempts(A);
  });

  test('a member, a guest and an admin without a password are refused; the recovery code unlocks', async () => {
    await lock(ada.browser, A);
    for (const who of [cy, dee]) {
      const response = await unlock(who.browser, A, { password: pw.ada });
      assert.equal(response.status, 403, response.text);
      assert.equal(codeOf(response), 'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED');
    }
    const noPassword = await unlock(ben.browser, A, { password: pw.ben });
    assert.equal(noPassword.status, 409);
    assert.equal(codeOf(noPassword), 'NO_UNLOCK_PASSWORD');
    const byCode = await unlock(ben.browser, A, { recoveryCode: recovery.toLowerCase().replace(/-/g, ' ') });
    assert.equal(byCode.status, 200, byCode.text);
    await clearAttempts(A);
  });

  test('an agent principal is refused before anything is read', async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('nothing may be read for an agent'); } }) as unknown as EncryptionUseCaseDeps;
    const useCases = createEncryptionUseCases({ ...untouched, keys: { swapSafe: true } } as unknown as EncryptionUseCaseDeps);
    await assert.rejects(useCases.unlock({ kind: 'agent', id: randomUUID() }, A, { password: pw.ada }), { status: 403, code: 'WORKSPACE_ENCRYPTION_ADMIN_REQUIRED' });
  });
});

describe('F-030 first passwords, grants and changes', () => {
  test('a promoted admin with only a session is refused; a holder\'s grant (wrong password 400) lets them set one, once; the others are told', async () => {
    const refused = await put(ben, A, { newPassword: pw.ben });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(codeOf(refused), 'UNLOCK_PASSWORD_GRANT_REQUIRED');
    const wrong = await grant(ada, A, ben.id, `${pw.ada}!`);
    assert.equal(wrong.status, 400);
    assert.equal(codeOf(wrong), 'UNLOCK_INCORRECT');
    assert.equal((await grant(cy, A, ben.id, pw.ada)).status, 403, 'a member cannot grant');
    assert.equal((await grant(ada, A, cy.id, pw.ada)).status, 403, 'the target must be an owner or admin');
    const granted = await grant(ada, A, ben.id, pw.ada);
    assert.equal(granted.status, 201, granted.text);
    const expiresIn = Date.parse((granted.json as { expiresAt: string }).expiresAt) - Date.now();
    assert.ok(expiresIn > 55 * 60_000 && expiresIn <= 60 * 60_000, `one hour (${expiresIn} ms)`);
    const set = await put(ben, A, { newPassword: pw.ben });
    assert.equal(set.status, 200, set.text);
    assert.equal((set.json as { encryption: { myPassword: boolean } }).encryption.myPassword, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_wrap_grants WHERE workspace_id = $1', [A])).rows[0].n, 0, 'the grant is consumed');
    const notices = (await pool.query(`SELECT user_id, title, body FROM notifications WHERE workspace_id = $1 AND reason = 'security'`, [A])).rows;
    assert.deepEqual(notices, [{ user_id: ada.id, title: 'Ben now has an unlock password for Garden club', body: '' }]);
    assert.equal((await grant(ada, A, ben.id, pw.ada)).status, 409, 'ALREADY_HAS_PASSWORD');
    await clearAttempts(A);
  });

  test('an expired grant is refused; the recovery code sets a first password instead', async () => {
    await addMember(ada, A, eve, 'admin');
    expectStatus(await grant(ada, A, eve.id, pw.ada), 201);
    await pool.query(`UPDATE workspace_wrap_grants SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND user_id = $2`, [A, eve.id]);
    const expired = await put(eve, A, { newPassword: pw.eve });
    assert.equal(expired.status, 403);
    assert.equal(codeOf(expired), 'UNLOCK_PASSWORD_GRANT_REQUIRED');
    const byCode = await put(eve, A, { recoveryCode: recovery, newPassword: pw.eve });
    assert.equal(byCode.status, 200, byCode.text);
    await lock(eve.browser, A);
    expectStatus(await unlock(eve.browser, A, { password: pw.eve }), 200);
    await clearAttempts(A);
  });

  test('changing a password needs the current one; the old one stops working', async () => {
    const next = passphrase();
    assert.equal((await put(ben, A, { newPassword: next })).status, 400, 'the current password or the code is required');
    const wrong = await put(ben, A, { currentPassword: pw.ada, newPassword: next });
    assert.equal(wrong.status, 400);
    assert.equal(codeOf(wrong), 'UNLOCK_INCORRECT');
    expectStatus(await put(ben, A, { currentPassword: pw.ben, newPassword: next }), 200);
    await lock(ben.browser, A);
    assert.equal((await unlock(ben.browser, A, { password: pw.ben })).status, 400);
    expectStatus(await unlock(ben.browser, A, { password: next }), 200);
    pw.ben = next;
    await clearAttempts(A);
  });

  test('a new recovery code is for owners, with their password; the old code stops working', async () => {
    const admin = await newCode(ben, A, pw.ben);
    assert.equal(admin.status, 403);
    assert.equal(codeOf(admin), 'OWNER_REQUIRED');
    const made = await newCode(ada, A, pw.ada);
    assert.equal(made.status, 200, made.text);
    const fresh = (made.json as { recoveryCode: string }).recoveryCode;
    assert.notEqual(fresh, recovery);
    await lock(ada.browser, A);
    assert.equal((await unlock(ben.browser, A, { recoveryCode: recovery })).status, 400, 'the old code');
    expectStatus(await unlock(ben.browser, A, { recoveryCode: fresh }), 200);
    recovery = fresh;
    await clearAttempts(A);
  });

  test('a demotion deletes the person\'s unlock password; the last one cannot be removed (role change and account deletion)', async () => {
    expectStatus(await ada.browser.request('PATCH', `/api/v1/workspaces/${A}/members/${eve.id}`, { body: { role: 'member' } }), 200);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM workspace_holders WHERE workspace_id = $1 AND user_id = $2`, [A, eve.id])).rows[0].n, 0);
    const keys = (await pool.query(`SELECT rotation, current_version FROM workspace_keys WHERE workspace_id = $1`, [A])).rows[0];
    assert.ok(keys.rotation !== 'none' || keys.current_version > 1, `a rotation is pending, running or done (S2c): ${JSON.stringify(keys)}`);
    // The tombstone stays until the rotation finishes (S2c clears it then).
    const tombstones = (await pool.query(`SELECT count(*)::int AS n FROM workspace_removed_holders WHERE workspace_id = $1 AND user_id = $2`, [A, eve.id])).rows[0].n;
    assert.ok(tombstones === 1 || (await events(A, 'workspace.key_rotated.v1')).length > 0, 'a tombstone until the finish');
    assert.equal((await unlock(eve.browser, A, { password: pw.eve })).status, 403);

    // Solo club: Fay creates it, Lou (owner) gets a password, Fay is demoted, so Lou holds the only one.
    const lou = await person('Lou');
    const fayPassword = passphrase();
    const louPassword = passphrase();
    const solo = (await createSealed(fay, 'Solo club', fayPassword)).workspace.id;
    await addMember(fay, solo, lou, 'owner');
    await addMember(fay, solo, ada, 'owner');
    expectStatus(await grant(fay, solo, lou.id, fayPassword), 201);
    expectStatus(await put(lou, solo, { newPassword: louPassword }), 200);
    expectStatus(await lou.browser.request('PATCH', `/api/v1/workspaces/${solo}/members/${fay.id}`, { body: { role: 'member' } }), 200);
    const last = await ada.browser.request('PATCH', `/api/v1/workspaces/${solo}/members/${lou.id}`, { body: { role: 'member' } });
    assert.equal(last.status, 409, last.text);
    assert.equal(codeOf(last), 'LAST_UNLOCK_PASSWORD');
    const leave = await lou.browser.request('DELETE', `/api/v1/workspaces/${solo}/members/${lou.id}`);
    assert.equal(leave.status, 409);
    assert.equal(codeOf(leave), 'LAST_UNLOCK_PASSWORD');
    await assert.rejects(pool.query('DELETE FROM auth_users WHERE id = $1', [lou.id]), { hint: 'LAST_UNLOCK_PASSWORD' }, 'an account deletion is refused too');
    await assert.rejects(pool.query(`INSERT INTO workspace_key_versions (workspace_id, key_version, commitment, check_value) VALUES ($1, 2, NULL, 'x')`, [A]),
      { code: '23514' }, 'a version after the first needs its commitment');
  });
});

describe('F-030 one password limiter for every checking route', () => {
  test('five wrong secrets spread over unlock, a grant, a password change and a new recovery code give 429 on all four; another holder still unlocks', async () => {
    const owner = await person('Gil');
    const admin = await person('Hal');
    const late = await person('Ivy');
    const passwords = { owner: passphrase(), admin: passphrase() };
    const { workspace: club } = await createSealed(owner, 'Limit club', passwords.owner);
    await addMember(owner, club.id, admin, 'admin');
    await addMember(owner, club.id, late, 'admin');
    expectStatus(await grant(owner, club.id, admin.id, passwords.owner), 201);
    expectStatus(await put(admin, club.id, { newPassword: passwords.admin }), 200);
    const bad = 'wrong wrong wrong wrong wrong wrong';
    for (const response of [await grant(owner, club.id, late.id, bad), await put(owner, club.id, { currentPassword: bad, newPassword: passphrase() }),
      await newCode(owner, club.id, bad)]) {
      assert.equal(response.status, 400, response.text);
      assert.equal(codeOf(response), 'UNLOCK_INCORRECT');
    }
    await lock(owner.browser, club.id);
    for (let i = 0; i < 2; i += 1) assert.equal(codeOf(await unlock(owner.browser, club.id, { password: bad })), 'UNLOCK_INCORRECT');
    const limited = await unlock(owner.browser, club.id, { password: passwords.owner });
    assert.equal(limited.status, 429, 'the sixth check, even with the right password');
    assert.equal(codeOf(limited), 'UNLOCK_RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0 && Number(limited.headers.get('retry-after')) <= 900);
    expectStatus(await unlock(admin.browser, club.id, { password: passwords.admin }), 200, 'the limit is per person: another admin unlocks');
    for (const response of [await grant(owner, club.id, late.id, passwords.owner), await put(owner, club.id, { currentPassword: passwords.owner, newPassword: passphrase() }),
      await newCode(owner, club.id, passwords.owner)]) {
      assert.equal(response.status, 429, response.text);
      assert.equal(codeOf(response), 'UNLOCK_RATE_LIMITED');
    }
    await pool.query(`UPDATE password_attempts SET at = now() - interval '16 minutes' WHERE workspace_id = $1`, [club.id]);
    expectStatus(await grant(owner, club.id, late.id, passwords.owner), 201, 'older than 15 minutes no longer count');
  });
});

describe('F-030 tampered key rows', () => {
  test('a replaced public key or a rogue holder makes unlock answer 409 ENCRYPTION_TAMPERED with no unlock row; repaired, it unlocks and clears the flag', async () => {
    const owner = await person('Jo');
    const member = await person('Kit');
    const password = passphrase();
    const { workspace: club, recoveryCode: code } = await createSealed(owner, 'Tamper club', password);
    await addMember(owner, club.id, member, 'member');
    await lock(owner.browser, club.id);
    const [holder] = (await pool.query(`SELECT * FROM workspace_holders WHERE workspace_id = $1 AND kind = 'password'`, [club.id])).rows;
    const [recoveryHolder] = (await pool.query(`SELECT * FROM workspace_holders WHERE workspace_id = $1 AND kind = 'recovery'`, [club.id])).rows;
    // (a) the owner's public key replaced by another valid key
    await pool.query(`UPDATE workspace_holders SET public_key = $2 WHERE id = $1`, [holder.id, recoveryHolder.public_key]);
    const replaced = await unlock(owner.browser, club.id, { password });
    assert.equal(replaced.status, 409, `the right password, a row that no longer opens: tampering, not a wrong password (${replaced.text})`);
    assert.equal(codeOf(replaced), 'ENCRYPTION_TAMPERED');
    assert.equal((await unlock(owner.browser, club.id, { password: `${password} typo` })).status, 400, 'a wrong password is still just wrong');
    const seen = await unlock(owner.browser, club.id, { recoveryCode: code });
    assert.equal(seen.status, 409, `the recovery holder's unlock verifies every holder's MAC: ${seen.text}`);
    assert.equal(codeOf(seen), 'ENCRYPTION_TAMPERED');
    await pool.query(`UPDATE workspace_holders SET public_key = $2 WHERE id = $1`, [holder.id, holder.public_key]);
    // (b) a rogue password holder for a member's account, copying a real row's material
    await pool.query(`INSERT INTO workspace_holders (id, workspace_id, kind, user_id, kdf, public_key, wrapped_private, holder_mac, holder_mac_version, secret_check)
      VALUES ($1, $2, 'password', $3, $4, $5, $6, $7, 1, $8)`, [randomUUID(), club.id, member.id, holder.kdf, holder.public_key, holder.wrapped_private, holder.holder_mac,
      holder.secret_check]);
    const rogue = await unlock(owner.browser, club.id, { password });
    assert.equal(rogue.status, 409, rogue.text);
    assert.equal(codeOf(rogue), 'ENCRYPTION_TAMPERED');
    const state = (await pool.query(`SELECT tampered_at IS NOT NULL AS tampered, (SELECT count(*)::int FROM workspace_unlocks WHERE workspace_id = $1) AS unlocks
      FROM workspace_keys WHERE workspace_id = $1`, [club.id])).rows[0];
    assert.deepEqual(state, { tampered: true, unlocks: 0 });
    assert.deepEqual((await pool.query(`SELECT title FROM notifications WHERE workspace_id = $1 AND reason = 'security'`, [club.id])).rows,
      [{ title: 'Tamper club\'s encryption keys were changed outside Flux. It stays locked.' }]);
    assert.equal((await events(club.id, 'workspace.encryption_tampered.v1')).length, 1);
    await pool.query(`DELETE FROM workspace_holders WHERE workspace_id = $1 AND user_id = $2`, [club.id, member.id]);
    expectStatus(await unlock(owner.browser, club.id, { password }), 200, 'repaired: the flag is not sticky');
    assert.equal((await pool.query(`SELECT tampered_at FROM workspace_keys WHERE workspace_id = $1`, [club.id])).rows[0].tampered_at, null);
  });
});

describe('F-030 AI forced off', () => {
  test('the policy is blocked at creation; PUT ai-policy gives 409; a direct update to allowed is refused by the trigger', async () => {
    assert.equal((await pool.query('SELECT state FROM workspace_ai_policies WHERE workspace_id = $1', [A])).rows[0].state, 'blocked');
    const version = (await readWorkspace(ada.browser, A)).ai.version;
    const response = await ada.browser.request('PUT', `/api/v1/workspaces/${A}/ai-policy`, { body: { state: 'allowed', expectedVersion: version } });
    assert.equal(response.status, 409, response.text);
    assert.equal(codeOf(response), 'WORKSPACE_ENCRYPTED_AI_OFF');
    await assert.rejects(pool.query(`UPDATE workspace_ai_policies SET state = 'allowed' WHERE workspace_id = $1`, [A]), { hint: 'WORKSPACE_ENCRYPTED_AI_OFF' });
    await assert.rejects(pool.query(`UPDATE workspaces SET encrypted = false WHERE id = $1`, [A]), { hint: 'WORKSPACE_ENCRYPTION_IMMUTABLE' });
  });

  test('every AI table with a workspace path has sealed_workspace_no_ai; a direct insert for A is refused, for B it passes the trigger', async () => {
    const tables = (await pool.query(`SELECT c.table_name AS name,
        bool_or(k.column_name = 'workspace_id') AS ws, bool_or(k.column_name = 'project_id') AS project, bool_or(k.column_name = 'agent_id') AS agent,
        bool_or(k.column_name = 'connection_id') AS connection,
        EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = ('public.' || c.table_name)::regclass AND t.tgname = 'a_sealed_workspace_no_ai') AS guarded
      FROM information_schema.tables c JOIN information_schema.columns k ON k.table_schema = 'public' AND k.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.table_type = 'BASE TABLE' AND (c.table_name LIKE 'agent%' OR c.table_name LIKE 'assistant%'
        OR c.table_name LIKE 'cowork%' OR c.table_name LIKE 'personal_run%' OR c.table_name LIKE 'proactive_comparison%' OR c.table_name = 'background_compute_connections')
      GROUP BY c.table_name ORDER BY c.table_name`)).rows as { name: string; ws: boolean; project: boolean; agent: boolean; connection: boolean; guarded: boolean }[];
    const withPath = tables.filter((t) => t.ws || t.project || t.agent || (t.connection && t.name.startsWith('agent')));
    assert.ok(withPath.length >= 30, `AI tables with a workspace path: ${withPath.length}`);
    assert.deepEqual(withPath.filter((t) => !t.guarded).map((t) => t.name), [], 'every one is guarded');
    const projectOf = async (ws: string, who: Person) =>
      (expectStatus(await who.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Seeds' } }), 201) as { id: string }).id;
    const paths = { A: { ws: A, project: await projectOf(A, ada) }, B: { ws: B, project: await projectOf(B, ada) } };
    for (const table of withPath.filter((t) => t.ws || t.project)) {
      const [column, of] = table.ws ? ['workspace_id', 'ws'] as const : ['project_id', 'project'] as const;
      const attempt = async (target: 'A' | 'B') => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO ${table.name} (${column}) VALUES ($1)`, [paths[target][of]]);
          return null;
        } catch (error) { return error as { hint?: string; code?: string }; } finally { await client.query('ROLLBACK'); client.release(); }
      };
      const sealed = await attempt('A');
      assert.equal(sealed?.hint, 'WORKSPACE_ENCRYPTED_AI_OFF', `${table.name}: refused for A first, by the backstop (${JSON.stringify(sealed)})`);
      const plain = await attempt('B');
      assert.ok(!plain || plain.hint !== 'WORKSPACE_ENCRYPTED_AI_OFF', `${table.name}: the trigger lets B through`);
    }
  });

  test('an F-029 gated route answers 403 WORKSPACE_AI_BLOCKED in A and works in B', async () => {
    for (const [ws, status] of [[A, 403], [B, 200]] as const) {
      const project = (expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Robots' } }), 201) as { id: string }).id;
      const response = await ada.browser.request('GET', `/api/v1/projects/${project}/agents`);
      assert.equal(response.status, status, response.text);
      if (status === 403) assert.equal(codeOf(response), 'WORKSPACE_AI_BLOCKED');
    }
  });

  test('#68: a personal assistant run is refused in A (403 WORKSPACE_AI_BLOCKED) with no run or usage row, and reaches its own checks in B', async () => {
    const before = Number((await pool.query('SELECT count(*) FROM personal_runs WHERE owner_user_id = $1', [ada.id])).rows[0].count);
    for (const [ws, status, code] of [[A, 403, 'WORKSPACE_AI_BLOCKED'], [B, 409, 'PERSONAL_RUN_NOT_ENABLED']] as const) {
      const project = (expectStatus(await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Assistant' } }), 201) as { id: string }).id;
      const thread = expectStatus(await ada.browser.request('POST', `/api/v1/projects/${project}/conversations`,
        { body: { body: 'Camera or ToF sensor?', clientMessageId: randomUUID() } }), 201) as { id: string };
      const asked = await ada.browser.request('POST', `/api/v1/conversations/${thread.id}/assistant-runs`, { body: { clientRunId: randomUUID(), kind: 'ask', prompt: 'Look' } });
      assert.deepEqual([asked.status, codeOf(asked)], [status, code], `${ws === A ? 'sealed A' : 'plain B'}: ${asked.text}`);
    }
    assert.equal(Number((await pool.query('SELECT count(*) FROM personal_runs WHERE owner_user_id = $1', [ada.id])).rows[0].count), before, 'no run row anywhere');
  });
});
