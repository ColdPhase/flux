import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DocRefType, NativeWorkRow, WorkObjectType } from '@flux/contracts';
import { useRevalidator } from 'react-router';
import { useShellData } from '../app/data';
import { listProjectSketches } from '../project/data';
import { useWorkChoices } from '../work/useDetailReads';
import { useWorkRead } from '../work/useWorkRead';
import { WorkPagination } from '../work/WorkPagination';
import { Icon } from '../ui';
import { getConversation, listConversations } from '../app/conversation-api';
import { listProjectDocs } from './api';
import { kindLabel } from './format';

// "Link…" in the doc editor: find something of this project and insert a `flux:` reference.
// Only objects of the same project are offered; the server checks again when the doc is saved.

export interface PickedRef { type: DocRefType; id: string; title: string }

interface Candidate extends PickedRef { hint: string }

async function candidates(projectId: string, workspaceId: string, selfId: string | null, signal: AbortSignal): Promise<Candidate[]> {
  const [docs, sketches, threads] = await Promise.all([
    listProjectDocs(projectId, signal),
    listProjectSketches(workspaceId, projectId, 100, 0, signal).then((page) => page.items),
    listConversations(projectId, signal).then((page) => page.items),
  ]);
  const recent = await Promise.all(threads.slice(0, 3).map((thread) => getConversation(thread.id, signal)));
  const line = (text: string) => { const first = text.trim().split('\n', 1)[0] ?? ''; return first.length > 90 ? `${first.slice(0, 89)}…` : first; };
  return [
    ...docs.filter((doc) => doc.id !== selfId).map((doc) => ({ type: 'doc' as const, id: doc.id, title: doc.title, hint: doc.state === 'draft' ? 'Draft page' : 'Page' })),
    ...sketches.filter((sketch) => sketch.scope === 'project' && sketch.projectId === projectId).map((sketch) => ({ type: 'sketch' as const, id: sketch.id, title: sketch.title, hint: 'Sketch' })),
    ...recent.flatMap((thread) => thread ? [...thread.messages].reverse().map((message) => ({ type: 'message' as const, id: message.id, title: line(message.body), hint: 'Message' })) : []),
  ];
}

const TYPES = ['all', 'doc', 'decision', 'result', 'work', 'sketch', 'message'] as const;
type ReferenceType = typeof TYPES[number];
function nativeCandidate(item: NativeWorkRow): Candidate {
  return { type: item.kind, id: item.id, title: item.title,
    hint: item.kind === 'decision' ? item.status === 'accepted' ? 'Current rule' : item.status === 'proposed' ? 'Proposed decision' : 'Earlier rule'
      : item.kind === 'result' ? item.finding === 'negative' ? 'Negative result' : 'Positive result' : 'Work' };
}

export function LinkPicker({ projectId, workspaceId, selfId, onPick, onClose }: {
  projectId: string; workspaceId: string; selfId: string | null;
  onPick: (ref: PickedRef) => void; onClose: () => void;
}) {
  const { me } = useShellData();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<ReferenceType>('all');
  const [position, setPosition] = useState({ key: '', index: 0 });
  const [refresh, setRefresh] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const needle = query.trim().toLowerCase();
  const selection = (kind: WorkObjectType) => ({ purpose: 'choices' as const, choice: 'doc_refs' as const, kind,
    q: needle && kindLabel(kind).toLowerCase().startsWith(needle) ? '' : query.trim() });
  const decisions = useWorkChoices(me.user.id, projectId, selection('decision'), type === 'all' || type === 'decision');
  const results = useWorkChoices(me.user.id, projectId, selection('result'), type === 'all' || type === 'result');
  const work = useWorkChoices(me.user.id, projectId, selection('work'), type === 'all' || type === 'work');
  const nativeReads = [decisions, results, work].filter((_, index) => type === 'all' || type === ['decision', 'result', 'work'][index]);
  const loadOther = useCallback((signal: AbortSignal) => candidates(projectId, workspaceId, selfId, signal), [projectId, workspaceId, selfId]);
  const otherNeeded = type === 'all' || type === 'doc' || type === 'sketch' || type === 'message';
  const other = useWorkRead(otherNeeded ? { accountId: me.user.id, projectId, selector: `doc-refs:other:${workspaceId}:${selfId ?? ''}` } : null,
    loadOther, refresh, revalidator.state === 'idle');
  const failed = nativeReads.some(({ read }) => read.phase === 'unavailable') || (otherNeeded && other.phase === 'unavailable');
  const busy = nativeReads.some(({ page, busy }) => !page || busy) || (otherNeeded && other.phase !== 'ready') || revalidator.state !== 'idle';
  const shown = useMemo(() => {
    if (failed || busy) return [];
    const external = other.phase === 'ready' ? other.value : [];
    const all = [...external.filter((item) => type === 'all' || item.type === type),
      ...(decisions.page?.items ?? []).map(nativeCandidate), ...(results.page?.items ?? []).map(nativeCandidate), ...(work.page?.items ?? []).map(nativeCandidate)];
    const found = all.filter((item) => !needle || item.title.toLowerCase().includes(needle) || kindLabel(item.type).toLowerCase().startsWith(needle));
    return type === 'all' ? found.slice(0, 40) : found;
  }, [failed, busy, other, type, decisions.page, results.page, work.page, needle]);
  const native = type === 'decision' ? decisions : type === 'result' ? results : type === 'work' ? work : null;
  const activeKey = JSON.stringify([me.user.id, projectId, workspaceId, selfId, type, query, ...nativeReads.map(({ page }) => page?.summary.observedAt)]);
  const active = position.key === activeKey ? Math.max(0, Math.min(position.index, shown.length - 1)) : 0;
  const setActive = (next: number | ((index: number) => number)) => setPosition((previous) => ({ key: activeKey,
    index: typeof next === 'function' ? next(previous.key === activeKey ? previous.index : 0) : next }));
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const list = listRef.current, option = document.getElementById(`${listId}-${active}`);
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect(), item = option.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [active, shown, listId]);
  const retry = () => { setRefresh((value) => value + 1); for (const read of nativeReads) read.onRefresh(); };

  const choose = (item: Candidate | undefined) => { if (item) onPick(item); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.max(0, Math.min(shown.length - 1, index + 1))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  return (
    <div className="doc-picker" role="dialog" aria-label="Link to something in this project">
      <div className="doc-picker__search">
        <Icon name="search" size={14} />
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          maxLength={200} aria-label="Find a doc, decision, result, work, sketch or message" placeholder={type === 'all' ? 'Find project objects…' : `Find ${kindLabel(type).toLowerCase()}…`} value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKey} />
      </div>
      <div className="doc-picker__type"><label htmlFor={`${listId}-type`}>Type</label><select id={`${listId}-type`} aria-label="Reference type" value={type} onChange={(event) => setType(event.target.value as ReferenceType)}>
        {TYPES.map((kind) => <option key={kind} value={kind}>{kind === 'all' ? 'All types' : kindLabel(kind)}</option>)}
      </select></div>
      <p className="doc-picker__keys doc-picker__touch">Tap a match to insert its link.</p>
      {failed ? <p className="doc-muted doc-picker__empty" role="alert">Could not load this project’s objects. <button type="button" className="ui-link" onClick={retry}>Retry objects</button></p> : null}
      {busy && !failed ? <p className="doc-muted doc-picker__empty" aria-busy="true">Loading…</p> : null}
      {!busy && !failed && !shown.length ? <p className="doc-muted doc-picker__empty">Nothing matches “{query}”.</p> : null}
      {native ? <WorkPagination page={native.page} busy={busy || failed} label="Reference pages" noun="matches" onCursor={native.onCursor} onRefresh={native.onRefresh} /> : null}
      {type === 'all' && !busy && !failed ? <p className="doc-muted doc-picker__browse">Showing up to 40 matches. Choose a type to browse more.</p> : null}
      <ul ref={listRef} className="doc-picker__list" id={listId} role="listbox" aria-label="Matches">
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
