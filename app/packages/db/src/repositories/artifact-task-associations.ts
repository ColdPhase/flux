import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { referencedProjectIds, referencedTaskIds } from './task-targets.js';
import { taskGraphRows } from './task-graph.js';
import { taskUseRows, TaskUseRefusal } from './task-use.js';

export interface ArtifactScope { workspaceId: string; projectId: string }
export interface CanonicalArtifact { kind: 'doc'|'material'|'result'|'decision'|'thought'; id: string; version?: number }
/** Direct scoped persisted relations only. This does NOT change the Undo reference resolver. */
export async function canonicalArtifactTaskIds(tx: DbExecutor, scope: ArtifactScope, artifact: CanonicalArtifact) {
  const l=schema.projectObjectLinks,w=schema.projectWorkItems;
  const material=artifact.kind==='doc'||artifact.kind==='material';
  const outgoing=artifact.kind==='result' ? and(eq(l.fromType,'result'),eq(l.fromId,artifact.id),eq(l.toType,'work'),eq(l.role,'about'))
    : artifact.kind==='decision' ? and(eq(l.fromType,'decision'),eq(l.fromId,artifact.id),eq(l.toType,'work'),inArray(l.role,['affects','still_applies']))
    : artifact.kind==='doc' ? and(eq(l.fromType,'doc'),eq(l.fromId,artifact.id),eq(l.toType,'work'),inArray(l.role,['mentions','source'])) : undefined;
  const incoming=material ? and(eq(l.fromType,'work'),eq(l.toId,artifact.id),inArray(l.toType,['doc','material']),inArray(l.role,['source','related']),
    or(isNull(l.toVersion),artifact.version===undefined?undefined:eq(l.toVersion,artifact.version)))
    : artifact.kind==='thought' ? and(eq(l.fromType,'work'),eq(l.toId,artifact.id),eq(l.toType,'thought'),inArray(l.role,['source','related'])) : undefined;
  const incomingRows=incoming?await tx.select({id:w.id}).from(l).innerJoin(w,eq(w.id,l.fromId)).where(and(incoming,
    eq(l.workspaceId,scope.workspaceId),eq(l.projectId,scope.projectId),eq(w.workspaceId,scope.workspaceId),eq(w.projectId,scope.projectId),isNull(w.creationRevertedAt))):[];
  const outgoingRows=outgoing?await tx.select({id:w.id}).from(l).innerJoin(w,eq(w.id,l.toId)).where(and(outgoing,
    eq(l.workspaceId,scope.workspaceId),eq(l.projectId,scope.projectId),eq(w.workspaceId,scope.workspaceId),eq(w.projectId,scope.projectId),isNull(w.creationRevertedAt))):[];
  return [...new Set([...incomingRows,...outgoingRows].map(r=>r.id))].sort();
}

/** Source locks precede this method; one complete graph/task pass retains safety and eligible reset recipients. */
export async function prepareCanonicalArtifactTaskUse(tx: DbExecutor, scope: ArtifactScope, artifact: CanonicalArtifact|null,
  safetyRefs: readonly {type:string;id:string}[]) {
  const projectsOf=async(ids:readonly string[])=>ids.length?(await tx.select({id:schema.projectWorkItems.projectId}).from(schema.projectWorkItems)
    .where(inArray(schema.projectWorkItems.id,[...ids]))).map(r=>r.id):[];
  const tasks=async()=>[...new Set([...await referencedTaskIds(tx,safetyRefs),...(artifact?await canonicalArtifactTaskIds(tx,scope,artifact):[])])].sort();
  const graphs=[...new Set([scope.projectId,...await referencedProjectIds(tx,safetyRefs),...await projectsOf(await tasks())])].sort();
  await taskGraphRows(tx).lockTaskGraphs(graphs);
  const safety=await referencedTaskIds(tx,safetyRefs),wanted=await tasks();
  if([...await referencedProjectIds(tx,safetyRefs),...await projectsOf(wanted)].some(p=>!graphs.includes(p)))throw new TaskUseRefusal('TASK_TARGET_SET_CHANGED');
  const held=await taskUseRows(tx).lockPrepared(wanted);
  // Existing mutations mark their safety targets; only genuine artifact progress additionally marks recipients.
  return {...held,projectIds:graphs,mark:(ids:readonly string[]=safety)=>held.mark(ids)};
}
