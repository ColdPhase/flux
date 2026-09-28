import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DocRefType } from '@flux/contracts';
import { Icon } from '../ui';
import { getConversation, listConversations } from '../app/conversation-api';
import { listSketches } from '../api/sketches';
import { loadProjectWork } from '../work/api';
import { listProjectDocs } from './api';
import { kindLabel } from './format';

// "Link…" in the doc editor: find something of this project and insert a `flux:` reference.
// Only objects of the same project are offered; the server checks again when the doc is saved.

export interface PickedRef { type: DocRefType; id: string; title: string }

interface Candidate extends PickedRef { hint: string }

async function candidates(projectId: string, workspaceId: string, selfId: string | null, signal: AbortSignal): Promise<Candidate[]> {
  const [docs, work, sketches, threads] = await Promise.all([
    listProjectDocs(projectId, signal),
    loadProjectWork(projectId, signal),
    listSketches(workspaceId, 100, 0, signal).then((page) => page.items).catch(() => []),
    listConversations(projectId, signal).then((page) => page.items).catch(() => []),
  ]);
  const recent = await Promise.all(threads.slice(0, 3).map((thread) => getConversation(thread.id, signal).catch(() => null)));
  const line = (text: string) => { const first = text.trim().split('\n', 1)[0] ?? ''; return first.length > 90 ? `${first.slice(0, 89)}…` : first; };
  return [
    ...docs.filter((doc) => doc.id !== selfId).map((doc) => ({ type: 'doc' as const, id: doc.id, title: doc.title, hint: doc.state === 'draft' ? 'Draft doc' : 'Doc' })),
    ...work.decisions.map((item) => ({ type: 'decision' as const, id: item.id, title: item.title, hint: item.status === 'accepted' ? 'Current rule' : item.status === 'proposed' ? 'Proposed decision' : 'Earlier rule' })),
    ...work.results.map((item) => ({ type: 'result' as const, id: item.id, title: item.title, hint: item.finding === 'negative' ? 'Negative result' : 'Positive result' })),
    ...work.work.map((item) => ({ type: 'work' as const, id: item.id, title: item.title, hint: 'Work' })),
    ...sketches.filter((sketch) => sketch.scope === 'project' && sketch.projectId === projectId).map((sketch) => ({ type: 'sketch' as const, id: sketch.id, title: sketch.title, hint: 'Sketch' })),
    ...recent.flatMap((thread) => thread ? [...thread.messages].reverse().map((message) => ({ type: 'message' as const, id: message.id, title: line(message.body), hint: 'Message' })) : []),
  ];
}

export function LinkPicker({ projectId, workspaceId, selfId, onPick, onClose }: {
  projectId: string; workspaceId: string; selfId: string | null;
  onPick: (ref: PickedRef) => void; onClose: () => void;
}) {
  const [all, setAll] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const controller = new AbortController();
    candidates(projectId, workspaceId, selfId, controller.signal).then(setAll, () => { if (!controller.signal.aborted) setFailed(true); });
    inputRef.current?.focus();
    return () => controller.abort();
  }, [projectId, workspaceId, selfId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = (all ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle) || kindLabel(item.type).toLowerCase().startsWith(needle));
    return found.slice(0, 40);
  }, [all, query]);

  const choose = (item: Candidate | undefined) => { if (item) onPick(item); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(shown.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  return (
    <div className="doc-picker" role="dialog" aria-label="Link to something in this project">
      <div className="doc-picker__search">
        <Icon name="search" size={14} />
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          aria-label="Find a doc, decision, result, work, sketch or message" placeholder="Find a doc, decision, result…" value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey} />
      </div>
      {failed ? <p className="doc-muted doc-picker__empty">Could not load this project’s objects.</p> : null}
      {all === null && !failed ? <p className="doc-muted doc-picker__empty" aria-busy="true">Loading…</p> : null}
      {all && !shown.length ? <p className="doc-muted doc-picker__empty">Nothing matches “{query}”.</p> : null}
      <ul className="doc-picker__list" id={listId} role="listbox" aria-label="Matches">
        {shown.map((item, index) => (
          <li key={`${item.type}:${item.id}`} id={`${listId}-${index}`} role="option" aria-selected={index === active}
            className="doc-picker__opt" onMouseDown={(event) => { event.preventDefault(); choose(item); }} onMouseEnter={() => setActive(index)}>
            <span className="doc-picker__k">{item.hint}</span><span className="doc-picker__t">{item.title || 'Untitled'}</span>
          </li>
        ))}
      </ul>
      <p className="doc-picker__keys"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close</p>
    </div>
  );
}
