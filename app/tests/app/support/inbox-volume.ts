import { pool } from './db.js';
import { addMember, person, workspace, type Person } from './people.js';

/** Rows inserted per statement, so each stays well under the pool's 2 s query timeout. */
const BATCH = 2000;

export interface InboxVolume {
  owner: Person;
  member: Person;
  workspaceId: string;
  /** The member's notifications by source kind; every one is readable by them. */
  notifications: { project: number; draft: number; dm: number };
  /** Rows of each source kind in the workspace that the member can read. */
  workspaceRows: { projects: number; drafts: number; dms: number };
}

async function batched(total: number, insert: (from: number, to: number) => Promise<unknown>) {
  for (let from = 1; from <= total; from += BATCH) await insert(from, Math.min(total, from + BATCH - 1));
}

/**
 * A workspace much larger than one person's inbox (#298 review): many projects, drafts and
 * direct messages the member can read, and a member with 3,000 notifications about a few of
 * them. Rows are inserted directly (the access rules are exercised by the reads under test, not
 * by these fixtures), then analyzed, so the planner sees the volume as it would in use.
 */
export async function inboxVolume(sizes = { projects: 300, drafts: 20_000, dms: 2_000 }): Promise<InboxVolume> {
  const owner = await person('Volume owner');
  const member = await person('Volume member');
  const space = await workspace(owner, 'Inbox volume');
  await addMember(owner, space.id, member, 'member');
  await batched(sizes.projects, (from, to) => pool.query(`INSERT INTO projects (id, workspace_id, name, visibility, created_by)
    SELECT gen_random_uuid(), $1, 'Project ' || i, 'workspace', $2 FROM generate_series($3::int, $4::int) AS i`, [space.id, owner.id, from, to]));
  await batched(sizes.drafts, (from, to) => pool.query(`INSERT INTO drafts (id, workspace_id, owner_user_id, title, visibility, created_by)
    SELECT gen_random_uuid(), $1, $2, 'Shared draft ' || i, 'workspace', $3 FROM generate_series($4::int, $5::int) AS i`,
  [space.id, owner.id, `human:${owner.id}`, from, to]));
  await batched(sizes.dms, async (from, to) => {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO dms (id, workspace_id, kind, title, created_by)
      SELECT gen_random_uuid(), $1, 'group', 'Group ' || i, $2 FROM generate_series($3::int, $4::int) AS i RETURNING id`, [space.id, owner.id, from, to]);
    await pool.query(`INSERT INTO dm_participants (workspace_id, dm_id, user_id)
      SELECT $1, dm.id, person.id FROM unnest($2::uuid[]) AS dm(id) CROSS JOIN unnest($3::text[]) AS person(id)`,
    [space.id, rows.map((row) => row.id), [owner.id, member.id]]);
  });
  const notifications = { project: 2800, draft: 100, dm: 100 };
  // `count` notifications spread over the first `distinct` rows of the table, oldest id first.
  const notify = (type: 'project' | 'draft' | 'dm', table: 'projects' | 'drafts' | 'dms', count: number, distinct: number) => pool.query(`
    WITH chosen AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM ${table} WHERE workspace_id = $2 ORDER BY id LIMIT $4)
    INSERT INTO notifications (id, user_id, workspace_id, source_type, source_id, title, reason)
    SELECT gen_random_uuid(), $1, $2, $3, chosen.id, 'About a ' || $3, 'reply'
    FROM generate_series(0, $5::int - 1) AS i JOIN chosen ON chosen.n = i % $4`, [member.id, space.id, type, distinct, count]);
  await notify('project', 'projects', notifications.project, sizes.projects);
  await notify('draft', 'drafts', notifications.draft, notifications.draft);
  await notify('dm', 'dms', notifications.dm, notifications.dm);
  await pool.query('ANALYZE notifications, projects, drafts, dms, dm_participants');
  const counted = await pool.query<{ source_type: 'project' | 'draft' | 'dm'; count: number }>(
    'SELECT source_type, count(*)::int AS count FROM notifications WHERE user_id = $1 GROUP BY source_type', [member.id]);
  for (const row of counted.rows) notifications[row.source_type] = row.count;
  return { owner, member, workspaceId: space.id, notifications, workspaceRows: { projects: sizes.projects, drafts: sizes.drafts, dms: sizes.dms } };
}
