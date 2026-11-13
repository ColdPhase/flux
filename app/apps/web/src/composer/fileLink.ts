import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * A link that opens a file's preview (C-63, #1382): a search result for a file goes to its message with `?file=<id>` (and `&page=<n>` for the page of a PDF
 * where the text matched). The row of that file opens its viewer while the link stands, and closing the viewer takes the link out of the address (the
 * message and its place stay), so a reload or Back does not open it again.
 *
 * A message can be drawn twice (the first message of a conversation is its thread's root as well), so the rows of one file settle which of them opens it:
 * the first to claim the link, and another if that one goes.
 */
export interface FileLink { page: number | null; close(): void }

const claims = new Map<string, symbol>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = () => listeners.forEach((listener) => listener());

export function useFileLink(fileId: string): FileLink | null {
  const { pathname, search, hash, state } = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(search);
  const linked = params.get('file')?.toLowerCase() === fileId.toLowerCase();
  const key = linked ? `${fileId}${search}` : null;
  const [token] = useState(() => Symbol('file row'));
  // Closing shuts the viewer at once; the address follows when the router has moved.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const owner = useSyncExternalStore(subscribe, () => (key ? claims.get(key) ?? null : null), () => null);
  useEffect(() => {
    if (key && owner === null && !claims.has(key)) { claims.set(key, token); changed(); }
  }, [key, owner, token]);
  useEffect(() => () => {
    if (key && claims.get(key) === token) { claims.delete(key); changed(); }
  }, [key, token]);
  if (!linked || owner !== token || dismissed === key) return null;
  const page = Number(params.get('page'));
  return {
    page: Number.isInteger(page) && page > 0 ? page : null,
    close() {
      setDismissed(key);
      params.delete('file');
      params.delete('page');
      const rest = params.toString();
      // Only the address changes: the conversation is not read again (as every other move of a query in the app).
      navigate({ pathname, search: rest ? `?${rest}` : '', hash }, { replace: true, defaultShouldRevalidate: false, state });
    },
  };
}
