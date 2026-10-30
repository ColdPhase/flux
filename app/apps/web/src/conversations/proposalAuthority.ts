import type { useReferenceWork } from '../work/useReferenceWork';

/**
 * What this person may do with an assistant's proposal (F-027): without a target, anyone who can write here once
 * their identity is read; with a task to finish, only who may edit that task as the bounded reference read saw it.
 */
export function proposalAuthority(finishes: { workId: string } | null, { writable, meId, referenceWork }: { writable: boolean; meId: string; referenceWork: ReturnType<typeof useReferenceWork> }) {
  if (!finishes) return { canAccept: writable && referenceWork.identityReady, canDismiss: writable && referenceWork.identityReady, targetState: 'ready' as const };
  const key = `work:${finishes.workId}`;
  const row = referenceWork.rows.get(key);
  const observed = referenceWork.actionable;
  const unavailable = observed && referenceWork.unavailable.has(key);
  const access = referenceWork.observation?.access;
  const canWrite = observed && access !== undefined && access !== 'viewer';
  const ownerAllows = row?.kind === 'work' && (access === 'manager' || !row.owner || row.owner.kind !== 'human' || row.owner.id === meId);
  return {
    canAccept: canWrite && !!ownerAllows,
    // A genuinely unavailable target can be dismissed under the native server's
    // final authority. Transport failure/unknown ownership cannot act as unowned.
    canDismiss: canWrite && (!!ownerAllows || unavailable),
    targetState: unavailable ? 'unavailable' as const : observed && row ? 'ready' as const
      : referenceWork.state.phase === 'unavailable' ? 'failed' as const : 'checking' as const,
  };
}
