import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { canonicalArtifactTaskIds, type ArtifactScope, type CanonicalArtifact } from './artifact-task-associations.js';
import { TaskUseRefusal } from './task-use.js';
import { fileRows } from './files.js';

export interface ArtifactBoundary { kind:'doc'|'material'|'result'|'decision'|'thought'|'github_pr'|'file';id:string;revision:string;contentIdentity?:string }
type Retained={readonly ids:readonly string[];mark(ids?:readonly string[]):Promise<void>};
/** Private canonical mutation hook only. No reset flag, authority, transactions, content store or public entry. */
export function artifactResetRows(tx:DbExecutor){return{
  async publishedFile(scope:ArtifactScope,fileId:string,retained:Retained){
    const file=await fileRows(tx).findFile(fileId);
    if(!file||file.workspaceId!==scope.workspaceId||file.projectId!==scope.projectId||file.state!=='ready'
      ||file.publishedAt===null||file.replayOf!==null||!file.sha256||file.size===null)return;
    const recipients=await tx.execute<{id:string}>(sql`SELECT DISTINCT w.id FROM project_files f
      LEFT JOIN project_messages m ON m.id=f.message_id AND m.workspace_id=f.workspace_id AND m.project_id=f.project_id
      LEFT JOIN project_conversations c ON c.id=m.conversation_id AND c.workspace_id=f.workspace_id AND c.project_id=f.project_id
      LEFT JOIN project_task_discussions d ON d.conversation_id=c.id AND d.workspace_id=f.workspace_id AND d.project_id=f.project_id
      LEFT JOIN sketch_thoughts t ON t.id=f.thought_id AND t.workspace_id=f.workspace_id
      LEFT JOIN sketches s ON s.id=t.sketch_id AND s.workspace_id=f.workspace_id AND s.project_id=f.project_id AND s.scope='project'
      JOIN project_work_items w ON w.workspace_id=f.workspace_id AND w.project_id=f.project_id AND w.creation_reverted_at IS NULL
        AND(w.id=COALESCE(c.work_id,d.work_id) OR(s.id IS NOT NULL AND EXISTS(SELECT 1 FROM project_object_links l
          WHERE l.workspace_id=f.workspace_id AND l.project_id=f.project_id AND l.from_type='work' AND l.from_id=w.id
            AND l.to_type='thought' AND l.to_id=t.id AND l.role IN('source','related'))))
      WHERE f.id=${fileId} ORDER BY w.id`);
    await this.record(scope,{kind:'file',id:file.id,revision:'published',contentIdentity:file.sha256+':'+file.size},recipients.rows.map(r=>r.id),retained);
  },
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
