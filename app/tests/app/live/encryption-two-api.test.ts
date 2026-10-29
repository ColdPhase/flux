import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveKek, normalizeRecoveryCode, openDekForHolder, parseKdfParams, unwrapPrivateKey, WorkspaceKey } from '@flux/core';
import { pool } from '../support/db.js';
import { Browser } from '../support/http.js';
import { codeOf, contentCall, createSealed, lock, passphrase, readWorkspace, unlock } from '../support/encryption.js';
import { person } from '../support/people.js';

// AC-4 of F-030 (#655, S1): two API containers, the worker and one keyring (scripts/check_encryption.sh with
// docker/compose.encryption.test.yaml, where PostgreSQL logs every statement with its parameters). Unlock on API-1 and
// read on API-2 at once; Lock on API-2 and API-1's next write answers 423. The test then derives every secret of the
// run from what it knows (the passwords and the recovery code) and the stored rows, exactly as the API does, and writes
// them in every encoding to the state volume; the script scans the whole PostgreSQL log (and the API, worker and
// keyring logs) for each and fails on any hit. The keyring's boot key never leaves the keyring process, so it has no
// canary here.

const api2 = process.env.FLUX_API2_URL;

test('two APIs share the lock state through the keyring; no secret reaches PostgreSQL', { skip: !api2 && 'FLUX_API2_URL is not set' }, async () => {
  const ada = await person('Ada');
  const ben = await person('Ben');
  const password = passphrase();
  const benPassword = passphrase();
  const { workspace, recoveryCode } = await createSealed(ada, 'Garden club', password);
  const ws = workspace.id;
  // The same session on the second API (both share the database and the auth secret).
  const second = new Browser(api2!);
  for (const [name, value] of ada.browser.cookies) second.cookies.set(name, value);
  await ada.browser.request('POST', `/api/v1/workspaces/${ws}/members`, { body: { email: ben.email, role: 'admin' } });
  assert.equal((await ada.browser.request('POST', `/api/v1/workspaces/${ws}/unlock-password-grants`, { body: { userId: ben.id, password } })).status, 201);
  assert.equal((await ben.browser.request('PUT', `/api/v1/workspaces/${ws}/unlock-password`, { body: { newPassword: benPassword } })).status, 200);

  assert.equal((await lock(ada.browser, ws)).status, 200);
  assert.equal((await contentCall(second, ws)).status, 423, 'API-2 sees the lock at once');
  assert.equal((await unlock(ada.browser, ws, { password })).status, 200, 'unlock on API-1');
  assert.equal((await contentCall(second, ws)).status, 200, 'API-2 reads at once');
  assert.equal((await readWorkspace(second, ws)).encryption?.state, 'unlocked');
  assert.equal((await lock(second, ws)).status, 200, 'lock on API-2');
  const write = await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'After the lock' } });
  assert.equal(write.status, 423, write.text);
  assert.equal(codeOf(write), 'WORKSPACE_LOCKED');
  assert.equal((await unlock(second, ws, { recoveryCode })).status, 200, 'the recovery code on API-2');
  assert.equal((await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Unlocked again' } })).status, 201);

  // S2b: the search index is bounded by its estimated heap, per workspace and across the workspaces of a process (api2 holds 300 000 B per
  // workspace and 400 000 B in all, docker/compose.encryption.test.yaml). A workspace that does not fit says so; API-1 answers for all.
  const heapOf = async (workspaceId: string, owner = ada) => ((await owner.browser.request('GET', '/api/v1/search/explain?q=fillerzero')).json as { sealedIndexHeap: Record<string, number> }).sealedIndexHeap[workspaceId] ?? 0;
  let serial = 0;
  const word = () => `fill${serial++}x${randomUUID().slice(0, 6)}`;
  async function filled(workspaceId: string, heap: number, marker: string, owner = ada) {
    const made = await owner.browser.request('POST', `/api/v1/workspaces/${workspaceId}/projects`, { body: { name: `Bulky ${marker}` } });
    assert.equal(made.status, 201);
    const projectId = (made.json as { id: string }).id;
    while (await heapOf(workspaceId, owner) < heap) {
      for (let n = 0; n < 2; n += 1) {
        const posted = await owner.browser.request('POST', `/api/v1/projects/${projectId}/conversations`,
          { body: { body: `${marker} ${Array.from({ length: 40 }, word).join(' ')}`, clientMessageId: randomUUID() }, headers: { 'idempotency-key': randomUUID() } });
        assert.equal(posted.status, 201, posted.text);
      }
    }
  }
  const second2 = await createSealed(ada, 'Second sealed', passphrase());
  const third = await createSealed(ada, 'Third sealed', passphrase());
  await filled(ws, 210_000, 'alphamarker');
  await filled(second2.workspace.id, 210_000, 'alphamarker');
  assert.ok(await heapOf(ws) < 300_000 && await heapOf(second2.workspace.id) < 300_000, 'each fits its own bound on API-1 and on API-2');
  const search = async (browser: Browser, q: string) => (await browser.request('GET', `/api/v1/search?q=${q}&limit=50`)).json as { items: { place: { id: string } }[]; sealedUnavailable?: string[] };
  const one = await search(ada.browser, 'alphamarker');
  assert.equal(one.sealedUnavailable, undefined, 'API-1 holds both');
  assert.ok(one.items.length >= 32);
  const other = await search(second, 'alphamarker');
  assert.equal(other.sealedUnavailable?.length, 1, 'API-2 has room for one of the two, not both (process bound)');
  assert.ok(other.items.length >= 16, 'and answers for the one it holds');
  assert.ok([ws, second2.workspace.id].includes(other.sealedUnavailable![0]!), 'it names one of the two');
  // A workspace over its own bound is unavailable on API-2 whatever else it holds, and fine on API-1.
  const bulky = await ada.browser.request('POST', `/api/v1/workspaces/${third.workspace.id}/projects`, { body: { name: 'Over the bound' } });
  assert.equal(bulky.status, 201);
  const huge = await ada.browser.request('POST', `/api/v1/projects/${(bulky.json as { id: string }).id}/conversations`,
    { body: { body: `betamarker ${Array.from({ length: 5000 }, word).join(' ')}`, clientMessageId: randomUUID() }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(huge.status, 201, huge.text);
  const bigOne = await search(ada.browser, 'betamarker');
  assert.equal(bigOne.items.length, 1);
  assert.equal(bigOne.sealedUnavailable?.includes(third.workspace.id) ?? false, false, 'API-1 holds it');
  const bigOther = await search(second, 'betamarker');
  assert.ok(bigOther.sealedUnavailable?.includes(third.workspace.id), 'API-2 is told the workspace is too large to search in memory');
  assert.equal(bigOther.items.length, 0);

  // Idle eviction (api2 evicts an index nobody searched for 3 s, FLUX_SEALED_SEARCH_IDLE_MS): two people with one workspace each, of the size
  // that fits the process bound only one at a time. Y fits once X is idle; right after, X has no room while Y is in use.
  const xavier = await person('Xavier'); const yara = await person('Yara');
  const [x, y] = [await createSealed(xavier, 'Xavier space', passphrase()), await createSealed(yara, 'Yara space', passphrase())];
  await filled(x.workspace.id, 210_000, 'gammamarker', xavier);
  await filled(y.workspace.id, 210_000, 'gammamarker', yara);
  const onApi2 = (who: typeof ada) => { const browser = new Browser(api2!); for (const [name, value] of who.browser.cookies) browser.cookies.set(name, value); return browser; };
  const [xSecond, ySecond] = [onApi2(xavier), onApi2(yara)];
  const idle = () => new Promise((resolve) => setTimeout(resolve, 3500));
  // Earlier searches left indexes on api2 too; once they are idle X builds in their place.
  await idle();
  const xFirst = await search(xSecond, 'gammamarker');
  assert.equal(xFirst.sealedUnavailable, undefined, 'X fits once the idle indexes of earlier searches are evicted');
  assert.ok(xFirst.items.length >= 16);
  await idle();
  const yFirst = await search(ySecond, 'gammamarker');
  assert.equal(yFirst.sealedUnavailable, undefined, 'Y fits because X was idle and was evicted');
  assert.ok(yFirst.items.length >= 16);
  const xAgain = await search(xSecond, 'gammamarker');
  assert.deepEqual(xAgain.sealedUnavailable, [x.workspace.id], 'X has no room while Y is in use: the process bound still holds');

  // Every secret of the run, derived from the passwords and code and the stored rows.
  const secrets: Buffer[] = [];
  const texts: string[] = [password, benPassword, recoveryCode, normalizeRecoveryCode(recoveryCode)!];
  const holders = (await pool.query(`SELECT id, kind, user_id, kdf, public_key, wrapped_private FROM workspace_holders WHERE workspace_id = $1`, [ws])).rows;
  const wraps = (await pool.query(`SELECT holder_id, key_version, ephemeral_public, sealed_dek FROM workspace_dek_wraps WHERE workspace_id = $1`, [ws])).rows;
  for (const holder of holders) {
    const secret = holder.kind === 'recovery' ? normalizeRecoveryCode(recoveryCode)! : holder.user_id === ada.id ? password : benPassword;
    const kek = await deriveKek(secret, parseKdfParams(holder.kdf));
    const privateKey = unwrapPrivateKey(kek, holder.wrapped_private, { workspaceId: ws, holderId: holder.id, kind: holder.kind, userId: holder.user_id }, holder.public_key);
    secrets.push(kek, privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
    for (const wrap of wraps.filter((row) => row.holder_id === holder.id)) {
      const dek = openDekForHolder(privateKey, { ephemeralPublic: wrap.ephemeral_public, sealedDek: wrap.sealed_dek },
        { workspaceId: ws, holderId: holder.id, keyVersion: wrap.key_version });
      const key = WorkspaceKey.fromDek(ws, wrap.key_version, dek);
      secrets.push(dek, key.sealKey.export(), key.fileKey.export());
    }
  }
  // The keyring's boot key, through its test-only reveal (scripts/check_encryption.sh turns it on).
  const reveal = await fetch('http://keyring:8090/v1/test/boot-key', { headers: { authorization: `Bearer ${process.env.FLUX_KEYRING_TOKEN ?? ''}` } });
  assert.equal(reveal.status, 200, 'the check stack reveals the boot key to the scan');
  secrets.push(Buffer.from((await reveal.json() as { bootKey: string }).bootKey, 'base64url'));
  assert.ok(secrets.length >= 10);
  const encodings = new Set<string>(texts);
  for (const secret of secrets) {
    for (const encoding of ['hex', 'base64', 'base64url'] as const) encodings.add(secret.toString(encoding).replace(/=+$/, ''));
    encodings.add(secret.toString('hex').toUpperCase());
    // The accidental renderings: util.inspect of a Buffer, and the byte array of JSON.stringify(buffer).
    encodings.add(`<Buffer ${[...secret].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}>`);
    encodings.add([...secret].join(','));
  }
  const state = process.env.FLUX_TEST_STATE_DIR ?? '/state';
  await writeFile(join(state, 'encryption-secrets.txt'), [...encodings].join('\n') + '\n');
  // Positive control: a value this test sends as a bind parameter must be found in the PostgreSQL log.
  const control = `CONTROL-${randomUUID()}`;
  await pool.query('SELECT $1::text AS control', [control]);
  await writeFile(join(state, 'encryption-control.txt'), `${control}\n`);
});
