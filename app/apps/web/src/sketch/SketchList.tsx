import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { SketchDetail } from '@flux/contracts';
import { Icon } from '../ui';
import { provenance, quote } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import { ThoughtImage } from './ThoughtImage';
import { linkOf } from './paste';
import { ThoughtTasks, type ThoughtTasksEntry } from './ThoughtTasks';
import { sibling, visibleRows, type OutlineRow } from './outline';
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
  /** Connecting and rearranging happen on a computer or tablet (S15). */
  arrange: boolean;
  personalOutline: PersonalOutline;
  /** The project's tasks linked to each thought (UI116-4); none outside a project. */
  tasks: Map<string, ThoughtTasksEntry>;
  projectId: string | null;
  helpId: string;
  onOpenTask(id: string): void;
  onPick(id: string, additive: boolean): void;
  onToggle(id: string): void;
  onEdit(id: string): void;
  onEditText(text: string): void;
  onFinishEdit(text: string | null): void;
  onAdd(parentId: string | null): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
  onNavigate(id: string, selection?: string[]): void;
  /** #510 AC-6: Tab / Shift+Tab put the thought under another one: its connection on the map moves. */
  onReparent(id: string, parentId: string | null, how: 'indent' | 'outdent'): void;
  onConnectFrom(id: string): void;
  onConnections(id: string): void;
  /** Create task from the selected thoughts; absent outside a project. */
  onTask: (() => void) | null;
  onSay(text: string): void;
}
interface ReturnPoint { sourceId: string; collapsed: string[]; selection: string[]; scrollTop: number }

/**
 * The map as a tree (#510): the root thoughts, their children and grandchildren with connector lines,
 * a connection's label as a tag before the child, "also under …" for a thought's other parents and its
 * tasks as a chip at the row's end. Dates appear on hover or focus; the actions only on the selected
 * row. Every thought occurs once, and every connection is either a branch or an "also under" (#134).
 */
export function SketchList({ sketch, meId, selection, connectFrom, editing, canWrite, arrange, personalOutline: view, tasks, projectId, helpId, ...on }: SketchListProps) {
  const root = useRef<HTMLUListElement>(null);
  const ids = useId();
  const pending = useRef<{ id: string; scrollTop?: number; context?: boolean } | null>(null);
  /** Shift+F10 or the menu key moves focus to the selected row's actions, keeping the selection. */
  const toActions = useRef<string | null>(null);
  const lastFocus = useRef<{ id: string; index: number } | null>(null);
  const [returnPoint, setReturnPoint] = useState<ReturnPoint | null>(null);
  const [moreId, setMoreId] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const rows = visibleRows(view.outline, view.state.collapsed);
  const position = new Map(rows.map((row, index) => [row.thought.id, index]));
  const source = returnPoint ? view.outline.byId.get(returnPoint.sourceId) : null;
  const last = selection.length ? selection[selection.length - 1]! : null;
  // One row is in the tab order (a roving tab stop): the selected one, else the one last focused.
  const current = last && position.has(last) ? last : focused && position.has(focused) ? focused : rows[0]?.thought.id;
  const rowEl = (id: string) => root.current?.querySelector<HTMLElement>(`.sk-li-t[data-id="${id}"]`) ?? null;
  const placeFocus = (target: HTMLElement, scrollTop?: number, context = false) => {
    target.focus({ preventScroll: true });
    const page = root.current?.closest<HTMLElement>('.sk-list-scroll, .sk-page');
    if (page && scrollTop !== undefined) page.scrollTop = scrollTop;
    else if (context) {
      const returnHeight = root.current?.parentElement?.querySelector('.sk-outline-return')?.getBoundingClientRect().height ?? 0;
      target.style.scrollMarginTop = `${returnHeight + 64}px`;
      target.scrollIntoView({ block: 'start', inline: 'nearest' });
    } else target.scrollIntoView({ block: 'nearest' });
  };
  const focus = (id: string, scrollTop?: number, afterRender = false, context = false) => {
    if (afterRender) { pending.current = { id, scrollTop, context }; return; }
    const target = rowEl(id);
    if (!target) { pending.current = { id, scrollTop, context }; return; }
    pending.current = null;
    placeFocus(target, scrollTop, context);
  };
  useLayoutEffect(() => {
    if (toActions.current) {
      const button = rowEl(toActions.current)?.querySelector<HTMLElement>('.sk-outline-actions button');
      if (button) { toActions.current = null; button.focus(); return; }
    }
    const next = pending.current;
    if (next) {
      const target = rowEl(next.id);
      if (target) {
        pending.current = null;
        placeFocus(target, next.scrollTop, next.context);
      }
    } else if (lastFocus.current && !view.outline.byId.has(lastFocus.current.id) && document.activeElement === document.body) {
      const nextRow = rows[Math.min(lastFocus.current.index, rows.length - 1)];
      if (nextRow) rowEl(nextRow.thought.id)?.focus();
    }
  });

  const follow = (sourceId: string, targetId: string) => {
    if (!view.outline.byId.has(targetId)) return;
    setReturnPoint({ sourceId, collapsed: [...view.state.collapsed], selection: [...selection], scrollTop: root.current?.closest('.sk-list-scroll, .sk-page')?.scrollTop ?? 0 });
    view.reveal(targetId);
    on.onNavigate(targetId);
    focus(targetId, undefined, true, true);
  };
  const goBack = () => {
    if (!returnPoint || !source) return;
    view.restoreCollapsed(returnPoint.collapsed.filter((id) => !source.ancestors.includes(id)));
    on.onNavigate(source.thought.id, returnPoint.selection);
    focus(source.thought.id, returnPoint.scrollTop, true);
    setReturnPoint(null);
  };
  /** Moving through the tree selects the row (unless a connection waits for its second thought). */
  const go = (id: string | undefined) => {
    if (!id) return;
    if (!connectFrom) on.onNavigate(id);
    focus(id);
  };
  const indent = (row: OutlineRow) => {
    const above = sibling(view.outline, row.thought.id, -1);
    if (!above) { on.onSay(`Nothing above ${quote(row.thought.text)} to put it under`); return; }
    view.reveal(above);
    if (view.state.collapsed.includes(above)) view.toggle(above);
    on.onReparent(row.thought.id, above, 'indent');
    focus(row.thought.id, undefined, true);
  };
  const outdent = (row: OutlineRow) => {
    if (!row.parentId) { on.onSay(`${quote(row.thought.text)} is already at the top level`); return; }
    on.onReparent(row.thought.id, view.outline.byId.get(row.parentId)?.parentId ?? null, 'outdent');
    focus(row.thought.id, undefined, true);
  };
  const reorder = (row: OutlineRow, step: -1 | 1) => {
    if (!view.move(row.thought.id, step)) { on.onSay(`${quote(row.thought.text)} is already ${step < 0 ? 'first' : 'last'} here`); return; }
    on.onSay(`Moved ${quote(row.thought.text)} ${step < 0 ? 'up' : 'down'} in your list`);
    focus(row.thought.id, undefined, true);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, row: OutlineRow, index: number) => {
    if (event.target !== event.currentTarget) return;
    const { id } = row.thought;
    const { key } = event;
    const selected = selection.includes(id);
    const collapsed = view.state.collapsed.includes(id);
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); reorder(row, key === 'ArrowUp' ? -1 : 1); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (key === 'ArrowDown') { event.preventDefault(); go(rows[index + 1]?.thought.id); }
    else if (key === 'ArrowUp') { event.preventDefault(); go(rows[index - 1]?.thought.id); }
    else if (key === 'Home') { event.preventDefault(); go(rows[0]?.thought.id); }
    else if (key === 'End') { event.preventDefault(); go(rows.at(-1)?.thought.id); }
    else if (key === 'ArrowLeft') {
      event.preventDefault();
      if (row.children.length && !collapsed) view.toggle(id);
      else go(row.parentId ?? undefined);
    } else if (key === 'ArrowRight') {
      event.preventDefault();
      if (row.children.length && collapsed) view.toggle(id);
      else go(row.children[0]);
    } else if (key === 'Tab') {
      // Only a selected row takes Tab; Escape clears the selection, and Tab then leaves the list.
      if (!selected || !arrange || !canWrite || connectFrom || editing) return;
      event.preventDefault();
      if (event.shiftKey) outdent(row); else indent(row);
    } else if (key === 'Enter') {
      event.preventDefault();
      if (connectFrom) on.onPick(id, false);
      else if (canWrite) on.onAdd(row.parentId);
    } else if (key === ' ') {
      event.preventDefault();
      if (connectFrom) on.onPick(id, false);
      else if (canWrite) on.onEdit(id);
      else if (row.children.length) view.toggle(id);
    } else if (key === 'F2' && canWrite) { event.preventDefault(); on.onEdit(id); }
    else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      if (!selected || last !== id) on.onNavigate(id);
      toActions.current = id;
      const button = event.currentTarget.querySelector<HTMLElement>('.sk-outline-actions button');
      if (button && selected && last === id) { toActions.current = null; button.focus(); }
    }
    else if ((key === '+' || key === '=') && canWrite) { event.preventDefault(); on.onAdd(id); }
    else if ((key === 'Delete' || key === 'Backspace') && canWrite) { event.preventDefault(); on.onRemove(selected ? selection : [id]); }
    else if (key === 'Escape') {
      if (moreId) { setMoreId(null); event.preventDefault(); }
      else if (on.onEscape()) { event.preventDefault(); event.stopPropagation(); }
    }
  };
  const quiet = (event: MouseEvent) => event.stopPropagation();
  /** Escape in the row's actions closes "More actions" and returns to the row. */
  const closeMore = (event: KeyboardEvent, id: string) => {
    if (event.key !== 'Escape' || moreId !== id) return;
    event.preventDefault();
    event.stopPropagation();
    setMoreId(null);
    focus(id);
  };

  const renderRow = (row: OutlineRow): ReactNode => {
    const thought = row.thought;
    const index = position.get(thought.id) ?? 0;
    const selected = selection.includes(thought.id);
    const collapsed = view.state.collapsed.includes(thought.id);
    const titleId = `${ids}-${thought.id}`;
    const tagId = `${titleId}-tag`;
    const placement = thought.placement ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open') : null;
    const link = linkOf(thought.text);
    const linked = projectId ? tasks.get(thought.id) : undefined;
    const label = row.link?.label ?? null;
    const also = row.also.flatMap(({ id, link: relation }) => { const other = view.outline.byId.get(id); return other ? [{ other, relation }] : []; });
    const acting = last === thought.id && !editing;
    const more = acting && moreId === thought.id;
    return (
      <li key={thought.id} role="none" data-id={thought.id} data-depth={row.depth}>
        {/* The row is the tree item: it takes focus and keys; its buttons are for pointers and touch. */}
        <div role="treeitem" className={`sk-li-t sk-outline-row${selected ? ' is-selected' : ''}`} data-id={thought.id}
          tabIndex={current === thought.id ? 0 : -1} aria-level={row.depth + 1} aria-selected={selected} aria-expanded={row.children.length ? !collapsed : undefined}
          aria-labelledby={label ? `${tagId} ${titleId}` : titleId}
          onFocus={(event) => { if (event.target !== event.currentTarget) return; lastFocus.current = { id: thought.id, index }; setFocused(thought.id); }}
          onKeyDown={(event) => keyDown(event, row, index)} onClick={(event) => { if (editing?.id !== thought.id) on.onPick(thought.id, event.shiftKey || event.metaKey || event.ctrlKey); }}>
          {row.children.length ? <button type="button" tabIndex={-1} className="sk-outline-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${quote(thought.text)}`}
            onClick={(event) => { quiet(event); view.toggle(thought.id); focus(thought.id); }}><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} /></button>
            : <span className="sk-outline-leaf" aria-hidden="true" />}
          {label ? <span className="sk-outline-tag" id={tagId}>{label}</span> : null}
          <span className="sk-outline-main">
            {editing?.id === thought.id && canWrite
              ? <ThoughtEditor key={`${editing.id}:${editing.attempt}`} className="sk-li-edit" initial={editing.initial} disabled={editing.saving} onChange={on.onEditText} onDone={on.onFinishEdit} />
              : <span className="sk-outline-title" id={titleId}>{thought.text}</span>}
            {placement ? <span className="sk-outline-meta">{placement}</span> : null}
            {also.length ? <span className="sk-outline-also" onClick={quiet}><Icon name="link" size={12} /><span>also under </span>{also.map(({ other, relation }, at) => (
              <Fragment key={relation.id}>{at ? ', ' : ''}<button type="button" aria-label={`Also under ${other.thought.text}`} onClick={() => follow(thought.id, other.thought.id)}>{other.thought.text}</button></Fragment>
            ))}</span> : null}
          </span>
          {/* The row's end: the date (on hover or focus, its room kept), the selected row's actions and, last, the task chip, so it never moves. */}
          <span className="sk-outline-end">
          <span className="sk-li-s">{provenance(thought, meId)}</span>
          {acting ? <span className="sk-outline-actions" role="group" aria-label={`Actions for ${quote(thought.text)}`} onClick={quiet} onKeyDown={(event) => closeMore(event, thought.id)}>
            {canWrite ? <>
              <button type="button" onClick={() => on.onEdit(thought.id)}><Icon name="edit" size={12} />Edit</button>
              <button type="button" aria-label="Add a child thought" onClick={() => on.onAdd(thought.id)}><Icon name="plus" size={12} />Child</button>
              {on.onTask ? <button type="button" aria-label="Create task from selected thoughts" onClick={on.onTask}><Icon name="tasks" size={12} />Create task</button> : null}
            </> : null}
            <button type="button" className="sk-outline-more" aria-label="More actions" aria-expanded={more} onClick={() => setMoreId(more ? null : thought.id)}><Icon name="more" size={14} /></button>
          </span> : null}
          {linked?.count && projectId ? <span className="sk-outline-chip" onClick={quiet}><ThoughtTasks thought={thought} tasks={linked} projectId={projectId} variant="list" onOpenTask={on.onOpenTask} /></span> : null}
          </span>
        </div>
        {more ? <div className="sk-outline-menu" role="group" aria-label={`More actions for ${quote(thought.text)}`} onKeyDown={(event) => closeMore(event, thought.id)}>
          {arrange && canWrite ? <>
            <button type="button" onClick={() => { setMoreId(null); indent(row); }}>Indent<kbd>Tab</kbd></button>
            <button type="button" onClick={() => { setMoreId(null); outdent(row); }}>Outdent<kbd>⇧Tab</kbd></button>
          </> : null}
          <button type="button" onClick={() => { setMoreId(null); reorder(row, -1); }}>Move up<kbd>⌥↑</kbd></button>
          <button type="button" onClick={() => { setMoreId(null); reorder(row, 1); }}>Move down<kbd>⌥↓</kbd></button>
          {arrange && canWrite ? <button type="button" aria-pressed={connectFrom === thought.id} onClick={() => { setMoreId(null); on.onConnectFrom(thought.id); }}>Connect…</button> : null}
          <button type="button" onClick={() => { setMoreId(null); on.onConnections(thought.id); }}>Connections</button>
          {canWrite ? <button type="button" onClick={() => { setMoreId(null); on.onRemove(selection.includes(thought.id) ? selection : [thought.id]); }}>Remove</button> : null}
        </div> : null}
        {thought.file || link ? <div className="sk-outline-body">
          {thought.file ? <ThoughtImage className="sk-li-img" fileId={thought.file.id} name={thought.file.name} /> : null}
          {link ? <a className="sk-li-link" href={link.href} target="_blank" rel="noopener noreferrer" aria-label={`Open link ${link.host} in a new tab`}><Icon name="link" size={12} />Open link · {link.host}</a> : null}
        </div> : null}
        {row.children.length && !collapsed ? <ul role="group">{row.children.map((id) => view.outline.byId.get(id)).filter((child): child is OutlineRow => !!child).map((child) => renderRow(child))}</ul> : null}
      </li>
    );
  };

  if (!sketch.thoughts.length) return <p className="sk-empty-list">No thoughts yet. Add the first one with <b>Thought</b>.</p>;
  return (
    <div className="sk-outline">
      {source ? <div className="sk-outline-return">
        <button type="button" className="sk-outline-back" onClick={goBack}><Icon name="chevron-left" size={14} />Back to {quote(source.thought.text)}</button>
      </div> : null}
      <ul className="sk-outline-list" role="tree" aria-multiselectable="true" aria-label={`Thoughts in ${sketch.title}`} aria-describedby={helpId} ref={root}>
        {view.outline.rows.filter((row) => row.depth === 0).map((row) => renderRow(row))}
      </ul>
      {canWrite && arrange ? <p className="sk-outline-keys" aria-hidden="true">
        <span><kbd>Enter</kbd> new thought</span><span><kbd>Tab</kbd> indent</span><span><kbd>⇧Tab</kbd> outdent</span>
        <span><kbd>⌥↑</kbd><kbd>⌥↓</kbd> move</span><span><kbd>Space</kbd> open</span>
      </p> : null}
    </div>
  );
}
