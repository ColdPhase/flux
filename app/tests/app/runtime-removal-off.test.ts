import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_ERRORS, AGENT_RUNTIME_PATH } from '@flux/contracts';
import { pool } from './support/db.js';
import { expectStatus, person } from './support/people.js';

// Real HTTP/SQL with the normal stack's operator switch off. The nonempty rows are display-fact
// fixtures, not a native slot/profile or vendor session. Refusal must precede release/revocation.
test('actual off-server removal refuses before changing a saved binding, connection or auth admission', async () => {
  const owner = await person('Removal Off Owner');
  const binding = randomUUID();
  const connection = randomUUID();
  const available = await pool.query<{ slot: string }>(`SELECT 'runtime-' || n AS slot FROM generate_series(900, 999) n
    WHERE NOT EXISTS (SELECT 1 FROM agent_runtime_slots WHERE slot = 'runtime-' || n) ORDER BY n LIMIT 1`);
  const slot = available.rows[0]?.slot;
  assert.ok(slot, 'an unused fixture slot exists in this isolated stack');
  const snapshot = async () => ({
    slots: (await pool.query('SELECT * FROM agent_runtime_slots WHERE slot = $1', [slot])).rows,
    bindings: (await pool.query('SELECT * FROM agent_runtime_bindings WHERE owner_user_id = $1 ORDER BY id', [owner.id])).rows,
    connections: (await pool.query('SELECT * FROM agent_runtime_connections WHERE owner_user_id = $1 ORDER BY id', [owner.id])).rows,
    operations: (await pool.query('SELECT * FROM agent_runtime_auth_operations WHERE owner_user_id = $1 ORDER BY id', [owner.id])).rows,
    admission: (await pool.query('SELECT * FROM agent_runtime_auth_admission ORDER BY singleton')).rows,
  });
  try {
    await pool.query("INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'held')", [slot]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`,
      [binding, owner.id, slot]);
    await pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, signed_out_at, sign_out_failed)
      VALUES ($1, $2, $3, 'claude_code', 'signed_out', '2026-10-07T10:01:00Z', false)`, [connection, owner.id, binding]);
    const before = await snapshot();
    assert.equal(before.bindings[0].state, 'active');
    assert.equal(before.connections[0].revoked_at, null);
    const status = expectStatus(await owner.browser.request('GET', AGENT_RUNTIME_PATH), 200) as { enabled: boolean };
    assert.equal(status.enabled, false);
    const refused = expectStatus(await owner.browser.request('DELETE', AGENT_RUNTIME_BINDING_PATH), 409) as { code: string };
    assert.equal(refused.code, AGENT_RUNTIME_ERRORS.off);
    assert.deepEqual(await snapshot(), before, 'no release, connection revocation, auth work or admission change');
  } finally {
    await pool.query('DELETE FROM auth_users WHERE id = $1', [owner.id]);
    await pool.query('DELETE FROM agent_runtime_slots WHERE slot = $1', [slot]);
  }
});
