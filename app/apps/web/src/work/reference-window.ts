/** At most this many distinct native identities are read for one assistant feed (RR2). */
export const REFERENCE_WINDOW = 100;

export interface ReferenceCandidates {
  /** The reference that holds focus, then the one the reader last pointed at or focused. */
  focused?: string | null;
  interacted?: string | null;
  /** References currently visible (citations). */
  visible: string[];
}

/**
 * The bounded RR2 selection, in priority order: the focused and interacted references, then
 * the visible citations; at most `limit` distinct allowed identities, sorted. Not a project collection or cache.
 */
export function selectReferenceWindow(candidates: ReferenceCandidates, allowed: ReadonlySet<string>, limit = REFERENCE_WINDOW): string[] {
  const ordered = [candidates.focused, candidates.interacted, ...candidates.visible];
  return [...new Set(ordered.filter((value): value is string => !!value && allowed.has(value)))].slice(0, limit).sort();
}
