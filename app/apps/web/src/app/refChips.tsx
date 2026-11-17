import { useState, type MouseEvent, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { searchTargetPath } from '@flux/contracts';
import { useFollow } from '../place/origin';
import { useToast } from '../ui';
import { useShellActions } from './shellContext';

// `#12` and `[[Wiki page]]` in a message open what they name (v0.2.1 real-model gate, train 37 row 9), as a thought's chip and a link do. The
// message keeps only the number or the title, so the chip finds it when it is pressed, with the reader's own search: in the space the message is
// read in, or among everything the reader can open where there is no space (an agent's chat, a direct message). Nothing is read before the
// press, so a page of messages costs no request for its chips; what the reader may not open is not found.

const text = (parts: { text: string }[]) => parts.map((part) => part.text).join('').trim();

/** Where a task number or a page title leads, for this reader, or null when nothing they can open has it. A task of the space being read is
 *  its target, so it opens in the panel beside the conversation, as its card does (round 15: the chip left for the Tasks board). */
async function find(kind: 'task' | 'wiki', value: string, projectId: string | undefined): Promise<string | { taskId: string } | null> {
  const { searchFlux } = await import('../search/api');
  const place = projectId ? `project:${projectId}` : null;
  if (kind === 'task') {
    const number = Number(value);
    const found = await searchFlux({ q: `#${number}`, place, type: 'work', limit: 10 });
    const item = found.items.find((result) => result.task?.number === number);
    if (!item) return null;
    return item.target.type === 'work' && item.target.projectId === projectId ? { taskId: item.target.id } : searchTargetPath(item.target);
  }
  const found = await searchFlux({ q: value, place, type: 'doc', limit: 10 });
  const wanted = value.trim().toLowerCase();
  const item = found.items.find((result) => result.target.type === 'doc' && text(result.title).toLowerCase() === wanted);
  // The page as it is now, not the version the search matched.
  return item && item.target.type === 'doc' ? `/projects/${item.target.projectId}/docs/${item.target.docId}` : null;
}

/** A task or Wiki page chip that opens what it names. */
export function RefChipOpen({ kind, value, className, children }: { kind: 'task' | 'wiki'; value: string; className: string; children: ReactNode }) {
  const { projectId } = useParams();
  const follow = useFollow();
  const { openDetails } = useShellActions();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const label = kind === 'task' ? `Open task #${value}` : `Open the Wiki page ${value}`;
  const open = async (event: MouseEvent<HTMLButtonElement>) => {
    // The chip is its own control: the message around it does not take the press.
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const to = await find(kind, value, projectId);
      if (to && typeof to === 'object') openDetails({ kind: 'work', id: to.taskId });
      else if (to) void follow(to);
      else toast({ message: kind === 'task' ? `#${value} isn’t there, or you can’t open it.` : `The page ${value} isn’t there, or you can’t open it.` });
    } catch {
      toast({ message: 'Couldn’t open it. Try again.', tone: 'danger' });
    } finally { setBusy(false); }
  };
  // Enter and Space are the chip's own too: the message row's keys (Enter opens its thread) do not get them.
  return <button type="button" className={`${className} ref-chip--open`} data-ref={kind} title={label} aria-busy={busy || undefined} onClick={(event) => void open(event)}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}>{children}</button>;
}
