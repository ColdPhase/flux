/** Board or List, as this person last chose on this device (#136). The board is the default. Tiny on purpose: the loading screen reads it too (#902). */
export type TaskMode = 'board' | 'list';
const MODE_KEY = 'flux.tasks.mode.';

export function preferredMode(userId: string): TaskMode {
  try { return localStorage.getItem(MODE_KEY + userId) === 'list' ? 'list' : 'board'; } catch { return 'board'; }
}

export function rememberMode(userId: string, mode: TaskMode) {
  try { localStorage.setItem(MODE_KEY + userId, mode); } catch { /* remembered for this visit only */ }
}
