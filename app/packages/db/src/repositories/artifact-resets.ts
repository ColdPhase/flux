import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { canonicalArtifactTaskIds, type ArtifactScope, type CanonicalArtifact } from './artifact-task-associations.js';
import { TaskUseRefusal } from './task-use.js';

export interface ArtifactBoundary { kind:'doc'|'material'|'result'|'decision'|'thought'|'github_pr'|'file';id:string;revision:string;contentIdentity?:string }
type Retained={readonly ids:readonly string[];mark(ids?:readonly string[]):Promise<void>};
/** Private canonical mutation hook only. No reset flag, authority, transactions, content store or public entry. */
export function artifactResetRows(tx:DbExecutor){return{
  async record(scope:ArtifactScope,boundary:ArtifactBoundary,taskIds:readonly string[],retained:Retained){
    const recipients=[...new Set(taskIds)].sort();if(recipients.some(id=>!retained.ids.includes(id)))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
    const old=await tx.execute<{id:string}>(sql`SELECT id FROM agent_thread_artifact_boundaries WHERE kind=${boundary.kind} AND source_id=${boundary.id} AND revision=${boundary.revision}`);
    if(old.rows.length)return;
    const inserted=await tx.execute<{id:string}>(sql`INSERT INTO agent_thread_artifact_boundaries(workspace_id,project_id,kind,source_id,revision,content_identity,transaction_id)
      VALUES(${scope.workspaceId},${scope.projectId},${boundary.kind},${boundary.id},${boundary.revision},${boundary.contentIdentity??null},txid_current())
      ON CONFLICT(kind,source_id,revision) DO NOTHING RETURNING id`);
    const id=inserted.rows[0]?.id;if(!id)return;
    const changed:string[]=[];
    for(const task of recipients){const row=await tx.execute<{task_id:string}>(sql`INSERT INTO agent_thread_artifact_resets(task_id,boundary_id,workspace_id,project_id)
      VALUES(${task},${id},${scope.workspaceId},${scope.projectId}) ON CONFLICT DO NOTHING RETURNING task_id`);if(row.rows.length)changed.push(task);}
    if(changed.length)await retained.mark(changed);
  },
  async canonical(scope:ArtifactScope,artifact:CanonicalArtifact,boundary:ArtifactBoundary,retained:Retained){
    await this.record(scope,boundary,await canonicalArtifactTaskIds(tx,scope,artifact),retained);
  },
}};
