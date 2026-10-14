import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';
import { pool } from './support/db.js';

const directory = 'packages/db/migrations';

test('0095 adds truthful issuer snapshots without guessing historical values and guards destructive reversal', async () => {
  const client = await pool.connect();
  const namespace = `identity_audit_issuers_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET LOCAL search_path TO ${namespace}, pg_catalog`);
    const manifest = await readMigrationManifest(directory, FLUX_SCHEMA_VERSION);
    assert.equal(FLUX_SCHEMA_VERSION, 95);
    assert.equal(manifest.find((file) => file.version === 95)?.name, '0095_identity_audit_issuers.sql');
    await client.query(await readFile(join(directory, '0093_identity_audit.sql'), 'utf8'));
    const legacyId = randomUUID();
    await client.query(`INSERT INTO auth_identity_audit
      (id,action,user_id,provider_id,old_subject,new_subject,actor,reason,mode)
      VALUES($1,'rekey','flux-user','oidc-legacy','old-sub','new-sub','operator-cli','issuer changed','prepare')`, [legacyId]);
    await client.query(await readFile(join(directory, '0095_identity_audit_issuers.sql'), 'utf8'));
    const legacy = (await client.query('SELECT id,provider_id,old_subject,new_subject,old_issuer,new_issuer FROM auth_identity_audit WHERE id=$1', [legacyId])).rows[0];
    assert.deepEqual(legacy, { id: legacyId, provider_id: 'oidc-legacy', old_subject: 'old-sub', new_subject: 'new-sub', old_issuer: null, new_issuer: null },
      'historical issuer provenance remains explicitly unknown');

    const newId = randomUUID();
    await client.query(`INSERT INTO auth_identity_audit
      (id,action,user_id,provider_id,old_subject,new_subject,old_issuer,new_issuer,actor,reason,mode)
      VALUES($1,'rekey','flux-user','oidc-current','new-sub','next-sub','https://old.example.test','https://new.example.test','operator-cli','issuer changed','prepare')`, [newId]);
    await client.query('SAVEPOINT protected_reverse');
    await assert.rejects(client.query(await readFile(join(directory, 'reverse/0095_identity_audit_issuers.down.sql'), 'utf8')),
      /Cannot reverse 0095 while issuer provenance is recorded/);
    await client.query('ROLLBACK TO SAVEPOINT protected_reverse');
    assert.equal((await client.query('SELECT old_issuer FROM auth_identity_audit WHERE id=$1', [newId])).rows[0].old_issuer, 'https://old.example.test');

    await client.query('DELETE FROM auth_identity_audit WHERE id=$1', [newId]);
    await client.query(await readFile(join(directory, 'reverse/0095_identity_audit_issuers.down.sql'), 'utf8'));
    assert.deepEqual((await client.query('SELECT id,provider_id,old_subject,new_subject FROM auth_identity_audit WHERE id=$1', [legacyId])).rows[0],
      { id: legacyId, provider_id: 'oidc-legacy', old_subject: 'old-sub', new_subject: 'new-sub' },
      'reversal preserves the pre-existing audit record');
    assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='auth_identity_audit' AND column_name='old_issuer'", [namespace])).rowCount, 0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
