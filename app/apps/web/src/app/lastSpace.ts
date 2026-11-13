/**
 * The space the person last worked in, kept per account on this device (#1438 point 6): the last one they opened or made a task in. Create
 * names it when it opens outside any space (from Home, the Inbox, the Spaces list), instead of the first space of the list, which is Everyone.
 */
const PREFIX = 'flux.last-space.';

export function lastSpace(userId: string): string | null {
  try { return localStorage.getItem(PREFIX + userId); } catch { return null; }
}

export function rememberSpace(userId: string, projectId: string) {
  try { if (lastSpace(userId) !== projectId) localStorage.setItem(PREFIX + userId, projectId); } catch { /* the first space of the list is the default */ }
}

/** Sign-out: forget every account's last space in this browser. */
export function forgetLastSpace() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}
