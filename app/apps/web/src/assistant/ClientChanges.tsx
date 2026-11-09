import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantChange, AssistantChangeScope } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { useSpaceAi } from '../ai/spaceAi';
import { useShellData } from '../app/data';
import { Button } from '../ui';
import { listObjectChanges } from './api';
import { WaitingChanges } from './WaitingChanges';
import './assistant.css';

// What a local client changed on a task, a Wiki page or a map, on that page (#868, mcp-cowork LC-2): the same change line with Undo as the
// assistant's messages, one per change, so an Undo takes back that change and never the client's earlier work (C-18). The newest three
// show; the earlier ones are one quiet button away. Everyone who can read the page sees the line; Undo is the owner's, or anyone who may
// edit it, and the server says which (`undoable`). Nothing shows while the space has AI off.

const SHOWN = 3;
/** The events that say the page's changes may have moved: the object's own changes, and an Undo by anyone. */
const MOVED: Record<AssistantChangeScope, RegExp> = {
  work: /^project\.(work_|assistant_change_undone\.)/, doc: /^project\.(doc_|assistant_change_undone\.)/, map: /^project\.assistant_change_undone\./,
};

export function ClientChanges({ projectId, kind, id, refreshKey }: {
  projectId: string; kind: AssistantChangeScope; id: string;
  /** Anything that says the page was read again (a task's activity, a page's version): the lines are read again with it. */
  refreshKey?: unknown;
}) {
  const { me, workspace } = useShellData();
  const aiOff = useSpaceAi(projectId).blocked || workspace?.role === 'guest';
  const [changes, setChanges] = useState<AssistantChange[]>([]);
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  const soon = useRef<number | null>(null);
  const reread = useCallback(() => {
    if (soon.current !== null) window.clearTimeout(soon.current);
    soon.current = window.setTimeout(() => { soon.current = null; setTick((value) => value + 1); }, 300);
  }, []);
  useEffect(() => () => { if (soon.current !== null) window.clearTimeout(soon.current); }, []);
  useEffect(() => {
    if (aiOff) return;
    const controller = new AbortController();
    listObjectChanges(projectId, kind, id, controller.signal).then((page) => setChanges(page.items), () => { /* the page is shown without its change lines */ });
    return () => controller.abort();
  }, [projectId, kind, id, aiOff, tick, refreshKey]);
  useStreamEvents(me.user.id, (event) => {
    // A map's own changes arrive as its sketch's events; a task's, a page's and anyone's Undo as the space's.
    if (event.objectType === 'sketch' ? kind === 'map' && event.objectId === id : event.objectType === 'project' && event.objectId === projectId && MOVED[kind].test(event.kind)) reread();
  }, reread);

  // Each change is its own group (its ID), newest first.
  const groups = useMemo(() => [...changes].reverse().map((change) => [change]), [changes]);
  if (aiOff || !groups.length) return null;
  const shown = all ? groups : groups.slice(0, SHOWN);
  const refresh = async () => { setTick((value) => value + 1); };
  return (
    <div className="client-changes" data-client-changes={kind}>
      {shown.map((group) => <WaitingChanges key={group[0]!.id} changes={group} onChanged={refresh} meId={me.user.id} standalone here />)}
      {shown.length < groups.length ? <Button variant="link" onClick={() => setAll(true)}>Show {groups.length - shown.length} earlier</Button> : null}
    </div>
  );
}
