import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { accessPorts, createDatabase, schema } from '@flux/db';
import { listProjectGrants, revokeProjectGrant, type Principal } from '@flux/core';

// The Compose PostgreSQL for tests that read or write rows directly (#83). Each test file runs in
// its own process, so this is one pool per file, closed after the file's tests.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
export const connectionString: string = url;
export const database = createDatabase(connectionString);
export const { db, pool } = database;
after(() => pool.end());

/** A person inserted directly as a user row, for tests that drive core without signing up over HTTP. */
export async function insertedHuman(label: string): Promise<Principal> {
  const id = randomUUID();
  await db.insert(schema.authUsers).values({ id, name: label, email: `${label}-${id}@example.test` });
  return { id, kind: 'human' };
}

/**
 * Puts a person in the state of a company member who was never added to a space, for one check, and returns the way back.
 * A company owner or admin always reaches every space (#903), so this edits the rows directly: it drops their grant, makes the
 * space restricted and makes them a plain member. Tests whose fixture person is the company's owner use it to show what an agent,
 * a run or a rule does when its owner no longer has the space; the product reaches the same state for a person who was added and removed.
 */
export async function loseSpace(projectId: string, userId: string): Promise<() => Promise<void>> {
  const workspaceId = (await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM projects WHERE id = $1', [projectId])).rows[0]!.workspace_id;
  const grants = (await pool.query('DELETE FROM project_grants WHERE project_id = $1 AND user_id = $2 RETURNING id, role, created_by, created_at', [projectId, userId])).rows as
    { id: string; role: string; created_by: string; created_at: Date }[];
  const visibility = (await pool.query<{ visibility: string }>("UPDATE projects p SET visibility = 'restricted' FROM projects o WHERE p.id = o.id AND p.id = $1 RETURNING o.visibility", [projectId])).rows[0]!.visibility;
  const role = (await pool.query<{ role: string }>("UPDATE workspace_members m SET role = 'member' FROM workspace_members o WHERE m.workspace_id = o.workspace_id AND m.user_id = o.user_id AND m.workspace_id = $1 AND m.user_id = $2 RETURNING o.role", [workspaceId, userId])).rows[0]!.role;
  return async () => {
    await pool.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId, role]);
    await pool.query('UPDATE projects SET visibility = $2 WHERE id = $1', [projectId, visibility]);
    for (const grant of grants) {
      await pool.query('INSERT INTO project_grants (id, workspace_id, project_id, user_id, role, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [grant.id, workspaceId, projectId, userId, grant.role, grant.created_by, grant.created_at]);
    }
  };
}

/**
 * Removes a person from a space through the use cases, as the DELETE route does (#903): the grant goes with its lock order and its event.
 * `executor` is the connection the change runs on, for the tests that hold a lock or a transaction around it.
 */
export async function removeFromSpaceCore(actor: Principal, projectId: string, who: Principal, executor: Parameters<typeof revokeProjectGrant>[3] = db) {
  const found = (await listProjectGrants(actor, projectId, executor, accessPorts)).find((item) => item.principal.id === who.id);
  if (!found) throw new Error('the person was added to the space');
  await revokeProjectGrant(actor, projectId, found.id, executor, accessPorts);
}
