import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { canonicalArtifactTaskIds, type ArtifactScope, type CanonicalArtifact } from './artifact-task-associations.js';
import { TaskUseRefusal } from './task-use.js';
import { fileRows } from './files.js';

export interface ArtifactBoundary { kind:'doc'|'material'|'result'|'decision'|'thought'|'github_pr'|'file';id:string;revision:string;contentIdentity?:string }
type Retained={readonly ids:readonly string[];mark(ids?:readonly string[]):Promise<void>};
/** A content edit to a linked doc, material or thought is not use of the task (#553, #238 AC-U2). */
const isContentEdit=(kind:ArtifactBoundary['kind'])=>kind==='doc'||kind==='material'||kind==='thought';
/**
 * A result, decision, pull request or published file that is about a task counts as use of it, which ends the Undo of an unused task
 * (#394, #238); an edit of a doc, material or thought it cites does not (#553). Private canonical mutation hook only. No flag, authority,
 * transactions, content store or public entry. The tasks must already be in the caller's fence.
 */
export function artifactUseRows(tx:DbExecutor){return{
  async publishedFile(scope:ArtifactScope,fileId:string,retained:Retained){
    const file=await fileRows(tx).findFile(fileId);
    if(!file||file.workspaceId!==scope.workspaceId||file.projectId!==scope.projectId||file.state!=='ready'
      ||file.publishedAt===null||file.replayOf!==null||!file.sha256||file.size===null)return;
    const recipients=await tx.execute<{id:string}>(sql`SELECT DISTINCT w.id FROM project_files f
      LEFT JOIN project_messages m ON m.id=f.message_id AND m.workspace_id=f.workspace_id AND m.project_id=f.project_id
      LEFT JOIN project_task_discussions d ON d.conversation_id=m.conversation_id AND d.workspace_id=f.workspace_id AND d.project_id=f.project_id
      LEFT JOIN sketch_thoughts t ON t.id=f.thought_id AND t.workspace_id=f.workspace_id
      LEFT JOIN sketches s ON s.id=t.sketch_id AND s.workspace_id=f.workspace_id AND s.project_id=f.project_id AND s.scope='project'
      JOIN project_work_items w ON w.workspace_id=f.workspace_id AND w.project_id=f.project_id AND w.creation_reverted_at IS NULL
        AND(w.id=d.work_id OR(s.id IS NOT NULL AND EXISTS(SELECT 1 FROM project_object_links l
          WHERE l.workspace_id=f.workspace_id AND l.project_id=f.project_id AND l.from_type='work' AND l.from_id=w.id
            AND l.to_type='thought' AND l.to_id=t.id AND l.role IN('source','related'))))
      WHERE f.id=${fileId} ORDER BY w.id`);
    await this.record(scope,{kind:'file',id:file.id,revision:'published',contentIdentity:file.sha256+':'+file.size},recipients.rows.map(r=>r.id),retained,file.thoughtId!==null);
  },
  async record(_scope:ArtifactScope,boundary:ArtifactBoundary,taskIds:readonly string[],retained:Retained,contentEdit=isContentEdit(boundary.kind)){
    const recipients=[...new Set(taskIds)].sort();if(recipients.some(id=>!retained.ids.includes(id)))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
    if(recipients.length&&!contentEdit)await retained.mark(recipients);
  },
  async canonical(scope:ArtifactScope,artifact:CanonicalArtifact,boundary:ArtifactBoundary,retained:Retained){
    await this.record(scope,boundary,await canonicalArtifactTaskIds(tx,scope,artifact),retained);
  },
}};
