/**
 * Where each project tab returns to (#136, #189): the open conversation, the Tasks view and the
 * Map's open sketch. Kept per signed-in account and project for this browser tab only, so another
 * account in the same browser never lands on someone else's place.
 */
export type RememberedView = 'conversation' | 'tasks' | 'map';

const key = (view: RememberedView, userId: string, projectId: string) => `flux.project-${view}.${userId}.${projectId}`;

export function remembered(view: RememberedView, userId: string, projectId: string): string | null {
  try { return sessionStorage.getItem(key(view, userId, projectId)); } catch { return null; }
}

export function remember(view: RememberedView, userId: string, projectId: string, value: string) {
  try { sessionStorage.setItem(key(view, userId, projectId), value); } catch { /* private mode: the tab opens its default */ }
}
