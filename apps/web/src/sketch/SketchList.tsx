import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { SketchDetail } from '@flux/contracts';
import { Icon } from '../ui';
import { provenance, quote } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import { groupingChoices, visibleRows, type OutlineRow } from './outline';
import type { PersonalOutline } from './useOutline';
import type { Editing } from './SketchView';
import './sketch-list.css';

export interface SketchListProps {
  sketch: SketchDetail;
  meId: string;
  selection: string[];
  connectFrom: string | null;
  editing: Editing | null;
  canWrite: boolean;
  personalOutline: PersonalOutline;
  onPick(id: string, additive: boolean): void;
  onToggle(id: string): void;
  onEdit(id: string): void;
  onFinishEdit(text: string | null): void;
  onAdd(parentId: string | null): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
  onNavigate(id: string, selection?: string[]): void;
}
interface ReturnPoint { sourceId: string; collapsed: string[]; selection: string[]; scrollTop: number }

/** One personal reading outline over the current authorized many-to-many graph (#134). */
export function SketchList({ sketch, meId, selection, connectFrom, editing, canWrite, personalOutline: view, ...on }: SketchListProps) {
  const root = useRef<HTMLOListElement>(null);
  const pending = useRef<{ id: string; scrollTop?: number } | null>(null);
  const lastFocus = useRef<{ id: string; index: number } | null>(null);
  const [returnPoint, setReturnPoint] = useState<ReturnPoint | null>(null);
  const [groupingId, setGroupingId] = useState<string | null>(null);
  const rows = visibleRows(view.outline, view.state.collapsed);
  const source = returnPoint ? view.outline.byId.get(returnPoint.sourceId) : null;
  const focus = (id: string, scrollTop?: number, afterRender = false) => {
    if (afterRender) { pending.current = { id, scrollTop }; return; }
    const target = root.current?.querySelector<HTMLButtonElement>(`.sk-li-t[data-id="${id}"]`);
    if (!target) { pending.current = { id, scrollTop }; return; }
    pending.current = null;
    target.focus({ preventScroll: true });
    const page = root.current?.closest('.sk-page');
    if (page && scrollTop !== undefined) page.scrollTop = scrollTop;
    else target.scrollIntoView({ block: 'nearest' });
  };
  useLayoutEffect(() => {
    const next = pending.current;
    if (next) {
      const target = root.current?.querySelector<HTMLButtonElement>(`.sk-li-t[data-id="${next.id}"]`);
      if (target) {
        pending.current = null;
        target.focus({ preventScroll: true });
        const page = root.current?.closest('.sk-page');
        if (page && next.scrollTop !== undefined) page.scrollTop = next.scrollTop;
        else target.scrollIntoView({ block: 'nearest' });
      }
    } else if (lastFocus.current && !view.outline.byId.has(lastFocus.current.id) && document.activeElement === document.body) {
      const nextRow = rows[Math.min(lastFocus.current.index, rows.length - 1)];
      if (nextRow) root.current?.querySelector<HTMLButtonElement>(`.sk-li-t[data-id="${nextRow.thought.id}"]`)?.focus();
    }
  });

  const follow = (sourceId: string, targetId: string) => {
    if (!view.outline.byId.has(targetId)) return;
    setReturnPoint({ sourceId, collapsed: [...view.state.collapsed], selection: [...selection], scrollTop: root.current?.closest('.sk-page')?.scrollTop ?? 0 });
    view.reveal(targetId);
    on.onNavigate(targetId);
    setGroupingId(null);
    focus(targetId, undefined, true);
  };
  const goBack = () => {
    if (!returnPoint || !source) return;
    view.restoreCollapsed(returnPoint.collapsed.filter((id) => !source.ancestors.includes(id)));
    on.onNavigate(source.thought.id, returnPoint.selection);
    focus(source.thought.id, returnPoint.scrollTop, true);
    setReturnPoint(null);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, row: OutlineRow, index: number) => {
    const { id } = row.thought;
    let destination: string | undefined;
    if (event.key === 'ArrowDown') destination = rows[index + 1]?.thought.id;
    else if (event.key === 'ArrowUp') destination = rows[index - 1]?.thought.id;
    else if (event.key === 'Home') destination = rows[0]?.thought.id;
    else if (event.key === 'End') destination = rows.at(-1)?.thought.id;
    else if (event.key === 'ArrowLeft') {
      if (row.children.length && !view.state.collapsed.includes(id)) { view.toggle(id); destination = id; }
      else destination = row.parentId ?? undefined;
    } else if (event.key === 'ArrowRight') {
      if (row.children.length && view.state.collapsed.includes(id)) { view.toggle(id); destination = id; }
      else destination = row.children[0];
    } else if (event.key === 'Enter' && canWrite && !connectFrom) { event.preventDefault(); on.onEdit(id); }
    else if (event.key === ' ') { event.preventDefault(); if (connectFrom) on.onPick(id, false); else on.onToggle(id); }
    else if ((event.key === '+' || event.key === '=') && canWrite) { event.preventDefault(); on.onAdd(id); }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && canWrite) { event.preventDefault(); on.onRemove(selection.includes(id) ? selection : [id]); }
    else if (event.key === 'Escape') {
      if (groupingId) { setGroupingId(null); event.preventDefault(); }
      else if (on.onEscape()) { event.preventDefault(); event.stopPropagation(); }
    }
    if (destination) { event.preventDefault(); focus(destination); }
  };

  if (!sketch.thoughts.length) return <p className="sk-empty-list">No thoughts yet. Add the first one with <b>Thought</b>.</p>;
  return (
    <div className="sk-outline">
      {(source || view.canUndo) ? <div className="sk-outline-return">
        {source ? <button type="button" className="sk-outline-back" onClick={goBack}><Icon name="chevron-left" size={14} />Back to {quote(source.thought.text)}</button> : null}
        {view.canUndo ? <button type="button" className="sk-outline-undo" onClick={() => { view.undo(); setGroupingId(null); if (lastFocus.current) focus(lastFocus.current.id, undefined, true); }}>Undo list grouping</button> : null}
      </div> : null}
      <ol className="sk-list sk-outline-list" aria-label={`Thoughts in ${sketch.title}`} ref={root}>
        {rows.map((row, index) => {
          const thought = row.thought;
          const selected = selection.includes(thought.id);
          const collapsed = view.state.collapsed.includes(thought.id);
          const relations = sketch.links.flatMap((link) => {
            const otherId = link.fromId === thought.id ? link.toId : link.toId === thought.id ? link.fromId : null;
            const other = otherId ? view.outline.byId.get(otherId) : null;
            return other && other.thought.id !== row.parentId && !row.children.includes(other.thought.id) ? [{ link, other }] : [];
          });
          const placement = thought.placement ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open') : null;
          const choices = groupingChoices(thought.id, view.outline, sketch.links);
          const parentLabel = row.parentId ? sketch.links.find((link) => (link.fromId === thought.id && link.toId === row.parentId) || (link.toId === thought.id && link.fromId === row.parentId))?.label : null;
          return (
            <li key={thought.id} data-id={thought.id} data-depth={row.depth} data-selected={selected ? 'true' : undefined} style={{ '--outline-depth': Math.min(row.depth, 8) } as CSSProperties}>
              <div className="sk-outline-row">
                {row.children.length ? <button type="button" className="sk-outline-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${quote(thought.text)}`} aria-expanded={!collapsed} onClick={() => { view.toggle(thought.id); focus(thought.id); }}><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} /></button> : <span className="sk-outline-leaf" aria-hidden="true" />}
                {editing?.id === thought.id ? <ThoughtEditor className="sk-li-edit" initial={editing.initial ?? thought.text} onDone={on.onFinishEdit} /> : <button type="button" className="sk-li-t" data-id={thought.id} aria-pressed={selected}
                  onClick={(event) => on.onPick(thought.id, event.shiftKey || event.metaKey || event.ctrlKey)} onFocus={() => { lastFocus.current = { id: thought.id, index }; }} onKeyDown={(event) => keyDown(event, row, index)}>{thought.text}{selected ? <span className="sk-outline-selected" aria-hidden="true"><Icon name="check" size={12} /></span> : null}</button>}
              </div>
              <div className="sk-outline-body">
                <span className="sk-li-s">{placement ? `${placement} · ` : ''}{provenance(thought, meId)}</span>
                {parentLabel ? <span className="sk-li-s">Connection · {parentLabel}</span> : null}
                {row.depth > 0 ? <details className="sk-outline-path"><summary>Path · level {row.depth}</summary><ol aria-label={`Path to ${thought.text}`}>{row.ancestors.map((id) => { const ancestor = view.outline.byId.get(id)!; return <li key={id}><button type="button" onClick={() => follow(thought.id, id)}>{ancestor.thought.text}</button></li>; })}</ol></details> : null}
                {relations.length ? <div className="sk-li-l sk-outline-related"><span>Related to </span>{relations.slice(0, 2).map(({ link, other }, relatedIndex) => <span key={link.id}>{relatedIndex ? ', ' : ''}<button type="button" aria-label={`Related to ${quote(other.thought.text)}`} onClick={() => follow(thought.id, other.thought.id)}>{other.thought.text}</button>{link.label ? <span className="sk-outline-label"> · {link.label}</span> : null}</span>)}{relations.length > 2 ? <details className="sk-outline-more-links"><summary>More relations</summary>{relations.slice(2).map(({ link, other }) => <span key={link.id}><button type="button" aria-label={`Related to ${quote(other.thought.text)}`} onClick={() => follow(thought.id, other.thought.id)}>{other.thought.text}</button>{link.label ? ` · ${link.label}` : ''}</span>)}</details> : null}</div> : null}
                {selected && !editing ? <div className="sk-outline-actions">
                  {canWrite ? <><button type="button" onClick={() => on.onEdit(thought.id)}><Icon name="edit" size={12} />Edit</button><button type="button" onClick={() => on.onAdd(thought.id)}><Icon name="plus" size={12} />Add thought</button></> : null}
                  <button type="button" aria-expanded={groupingId === thought.id} onClick={() => setGroupingId(groupingId === thought.id ? null : thought.id)}>Group in list…</button>
                </div> : null}
                {groupingId === thought.id ? <Grouping row={row} choices={choices} onGroup={(parentId) => { view.group(thought.id, parentId); setGroupingId(null); focus(thought.id, undefined, true); }} onCancel={() => { setGroupingId(null); focus(thought.id); }} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Grouping({ row, choices, onGroup, onCancel }: { row: OutlineRow; choices: OutlineRow[]; onGroup(id: string | null): void; onCancel(): void }) {
  const [parentId, setParentId] = useState(row.parentId ?? '');
  return <form className="sk-outline-grouping" onSubmit={(event) => { event.preventDefault(); onGroup(parentId || null); }}>
    <label>In your list<select autoFocus aria-label={`Group ${quote(row.thought.text)} in your list`} value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">Top level</option>{choices.map((choice) => <option key={choice.thought.id} value={choice.thought.id}>Under {choice.thought.text}</option>)}</select></label>
    <span className="sk-outline-hint">Only your view in this browser changes.</span>
    <div><button type="submit" className="ui-btn ui-btn--secondary">Apply grouping</button><button type="button" className="ui-btn ui-btn--quiet" onClick={onCancel}>Cancel</button></div>
  </form>;
}
