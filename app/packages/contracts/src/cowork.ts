/** Coordination references only; source contents and current authority stay in their domains. */
export type CoWorkSourceRef =
  | { type: 'message'; id: string }
  | { type: 'material' | 'doc' | 'work' | 'thought'; id: string; version: number }
  | { type: 'github_pr'; bindingId: string; linkId: string; headSha: string };
