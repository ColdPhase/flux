import { useEffect, useState } from 'react';
import { listDmSketches } from '../api/sketches';
import { useStreamEvents } from '../api/stream';

/**
 * The number of sketches in a direct message, for its Sketches tab (#96). It follows sketch
 * events on the stream; it is null until known and for DMs the person cannot open.
 */
export function useDmSketchCount(workspaceId: string | undefined, dmId: string | undefined, meId: string) {
  const [count, setCount] = useState<{ dmId: string; total: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!workspaceId || !dmId) return;
    const controller = new AbortController();
    listDmSketches(workspaceId, dmId, 1, 0, controller.signal).then((page) => setCount({ dmId, total: page.total }), () => undefined);
    return () => controller.abort();
  }, [workspaceId, dmId, refresh]);
  useStreamEvents(meId, (event) => { if (event.objectType === 'sketch' && event.kind === 'sketch.created.v1') setRefresh((n) => n + 1); }, () => setRefresh((n) => n + 1));
  return count && count.dmId === dmId ? count.total : null;
}
