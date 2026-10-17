import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ASSISTANT_BACKGROUND_NOTE_VERSION, PERSONAL_RUNTIME_CONSENT_VERSION, type Project, type Workspace } from '@flux/contracts';
import { noPersonalConnections, type AgentRuntimeConfig, type Principal } from '@flux/core';
import { assistantJobUseCases } from '../../apps/server/src/assistant/jobs.js';
import { personalRunUseCases } from '../../apps/server/src/personal-runs/adapters.js';
import { personalRuntimeAvailability } from '../../apps/server/src/personal-runs/runtime.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, project as createProject, workspace as createWorkspace, type Person } from './support/people.js';
import { FakeQueue } from './support/personal-runs.js';

// F-027 A8 (#408), AST-2.1: the first background item on a subscription account shows the note once for that account, before
// activation, and records the owner's Turn on with the note's version; later items on the same account show only the meta
// line. The owner's Claude Code is a database row here (as the sign-in console leaves it); no CLI, vendor or key is used.

const queue = new FakeQueue();
const human = (someone: Person): Principal => ({ kind: 'human', id: someone.id });
const config: AgentRuntimeConfig = { clients: ['claude_code'], commercialTermsAgreedOn: '2026-10-05', idleDays: null, manager: { url: 'http://127.0.0.1:9', secret: 'unused-secret-for-status-only' } };
const boss = { send: async () => randomUUID() } as never;

describe('the note about background use of a subscription (F-027 A8, AST-2.1)', () => {
  let owner: Person; let ws: Workspace; let place: Project;
  const runtime = personalRuntimeAvailability(config, db);
  const jobs = () => assistantJobUseCases(db, boss, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime });
  const input = (extra: Record<string, unknown> = {}) => ({ projectId: place.id, text: 'List what we finished this week', schedule: { kind: 'weekly' as const, at: '16:00', weekday: 5 }, timeZone: 'UTC', ...extra });

  before(async () => {
    owner = await person('note-ada');
    ws = await createWorkspace(owner, 'Notes');
    place = await createProject(owner, ws.id, 'Lamp sensor', 'workspace');
    const agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`, { body: { name: 'My assistant', owner: 'self' } }), 201) as { id: string }).id;
    const slot = `runtime-${700 + Math.floor(Math.random() * 99)}`; const bindingId = randomUUID();
    await pool.query(`INSERT INTO agent_runtime_slots(slot, state) VALUES ($1, 'held') ON CONFLICT (slot) DO UPDATE SET state = 'held'`, [slot]);
    await pool.query(`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state) VALUES ($1, $2, $3, 'active')`, [bindingId, owner.id, slot]);
    await pool.query(`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, sign_in_method, auth_method, account_label, signed_in_at)
      VALUES ($1, $2, $3, 'claude_code', 'signed_in', 'claude_account', 'claude.ai', 'o***@example.org', now())`, [randomUUID(), owner.id, bindingId]);
    await personalRunUseCases(db, { queue: queue.factory, connections: noPersonalConnections, providerEnabled: false, runtime })
      .enable(human(owner), { consentVersion: PERSONAL_RUNTIME_CONSENT_VERSION, agentId, engine: 'runtime' });
  });

  after(async () => { await pool.query(`DELETE FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id]); });

  test('the first Turn on needs the note\'s version and records it; later schedules on the same account do not', async () => {
    const note = await jobs().note(human(owner), ws.id, owner.id);
    assert.equal(note.meta, 'Runs on your Claude plan');
    assert.equal(note.version, ASSISTANT_BACKGROUND_NOTE_VERSION);
    assert.equal(note.note, 'Runs on your Claude plan while you\'re away. Anthropic may limit this use without notice. If your plan says no, it skips that time and tells you.');
    for (const noteVersion of [undefined, 'an-older-version']) {
      await assert.rejects(jobs().create(human(owner), ws.id, owner.id, input(noteVersion ? { noteVersion } : {}) as never), { code: 'ASSISTANT_BACKGROUND_NOTE_REQUIRED' });
    }
    assert.equal((await pool.query(`SELECT 1 FROM assistant_jobs WHERE owner_user_id = $1`, [owner.id])).rowCount, 0, 'nothing was created or turned on without the note');
    assert.equal((await pool.query(`SELECT 1 FROM assistant_background_notes WHERE owner_user_id = $1`, [owner.id])).rowCount, 0);

    const first = await jobs().create(human(owner), ws.id, owner.id, input({ noteVersion: note.version }) as never);
    assert.equal(first.enabled, true);
    const recorded = (await pool.query(`SELECT account_key, note_version FROM assistant_background_notes WHERE owner_user_id = $1`, [owner.id])).rows;
    assert.deepEqual(recorded, [{ account_key: 'runtime:claude_code', note_version: ASSISTANT_BACKGROUND_NOTE_VERSION }]);

    const after = await jobs().note(human(owner), ws.id, owner.id);
    assert.deepEqual([after.note, after.meta], [null, 'Runs on your Claude plan']);
    const second = await jobs().create(human(owner), ws.id, owner.id, input({ text: 'Another one' }) as never);
    assert.equal(second.enabled, true, 'later items on the same account show only the meta line');
    assert.equal((await pool.query(`SELECT 1 FROM assistant_background_notes WHERE owner_user_id = $1`, [owner.id])).rowCount, 1);
  });

  test('a schedule that is off can be turned on later, and then it needs the note on an account that has not seen it', async () => {
    await pool.query(`DELETE FROM assistant_background_notes WHERE owner_user_id = $1`, [owner.id]);
    const off = await jobs().create(human(owner), ws.id, owner.id, input({ enabled: false, text: 'Prepared one' }) as never);
    assert.deepEqual([off.enabled, off.next], [false, []]);
    await assert.rejects(jobs().update(human(owner), ws.id, owner.id, off.id, { expectedVersion: off.version, enabled: true }), { code: 'ASSISTANT_BACKGROUND_NOTE_REQUIRED' });
    const on = await jobs().update(human(owner), ws.id, owner.id, off.id, { expectedVersion: off.version, enabled: true, noteVersion: ASSISTANT_BACKGROUND_NOTE_VERSION });
    assert.equal(on.enabled, true);
  });
});
