/** At most this many distinct native identities are read for one assistant feed (RR2). */
export const REFERENCE_WINDOW = 100;

export interface ReferenceCandidates {
  /** The reference that holds focus, then the one the reader last pointed at or focused. */
  focused?: string | null;
  interacted?: string | null;
  /** Proposal targets in the loaded answer window with their distance from the viewport in px (0 = visible). */
  proposals: { ref: string; distance: number }[];
  /** References currently visible (citations and proposals). */
  visible: string[];
}

/**
 * The bounded RR2 selection, in priority order: the focused and interacted references, then
 * proposal targets nearest the viewport first (visible ones at distance 0, ties in reading
 * order), then visible citations; at most `limit` distinct allowed identities, sorted. Every
 * proposal target in the loaded window is read while there are at most `limit - 2` of them;
 * beyond that the farthest wait until the reader scrolls or moves focus nearer, and their
 * Accept stays unavailable until read. Not a project collection or cache.
 */
export function selectReferenceWindow(candidates: ReferenceCandidates, allowed: ReadonlySet<string>, limit = REFERENCE_WINDOW): string[] {
  const proposals = candidates.proposals
    .map((proposal, index) => ({ ...proposal, index }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map((proposal) => proposal.ref);
  const ordered = [candidates.focused, candidates.interacted, ...proposals, ...candidates.visible];
  return [...new Set(ordered.filter((value): value is string => !!value && allowed.has(value)))].slice(0, limit).sort();
}
