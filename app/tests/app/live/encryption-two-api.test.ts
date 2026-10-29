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

  // S2b: a workspace too large for one API's search index (api2 holds 4 KiB, FLUX_SEALED_SEARCH_MAX_BYTES) says so; API-1 answers.
  const bulky = await ada.browser.request('POST', `/api/v1/workspaces/${ws}/projects`, { body: { name: 'Bulky notes' } });
  assert.equal(bulky.status, 201);
  const opened = await ada.browser.request('POST', `/api/v1/projects/${(bulky.json as { id: string }).id}/conversations`,
    { body: { body: `bulky ${'filler '.repeat(900)}`, clientMessageId: randomUUID() }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(opened.status, 201, opened.text);
  const first = (await ada.browser.request('GET', '/api/v1/search?q=bulky')).json as { items: unknown[]; sealedUnavailable?: string[] };
  assert.ok(first.items.length >= 1 && !first.sealedUnavailable, 'API-1 finds it');
  const other = (await second.request('GET', '/api/v1/search?q=bulky')).json as { items: unknown[]; sealedUnavailable?: string[] };
  assert.deepEqual(other.sealedUnavailable, [ws], 'API-2 is told the workspace is too large to search in memory');
  assert.equal(other.items.length, 0);

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
