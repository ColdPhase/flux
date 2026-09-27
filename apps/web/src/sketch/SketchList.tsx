import type { SketchDetail } from '@flux/contracts';
import { readingOrder } from './geometry';
import { provenance } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import type { Editing } from './SketchView';

export interface SketchListProps {
  sketch: SketchDetail;
  meId: string;
  selection: string[];
  connectFrom: string | null;
  editing: Editing | null;
  canWrite: boolean;
  onPick(id: string, additive: boolean): void;
  onToggle(id: string): void;
  onEdit(id: string): void;
  onFinishEdit(text: string | null): void;
  onAdd(parentId: string | null): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
}

/**
 * List: the same thoughts in reading order with their links spelled out (`#lamp-map-list`).
 * It is the accessible alternative to the map and carries the same keyboard actions.
 */
export function SketchList({ sketch, meId, selection, connectFrom, editing, canWrite, ...on }: SketchListProps) {
  const text = new Map(sketch.thoughts.map((t) => [t.id, t.text]));
  if (!sketch.thoughts.length) return <p className="sk-empty-list">No thoughts yet. Add the first one with <b>Thought</b>.</p>;
  return (
    <ol className="sk-list" aria-label={`Thoughts in ${sketch.title}`}>
      {readingOrder(sketch.thoughts).map((thought) => {
        const links = sketch.links.filter((l) => l.fromId === thought.id || l.toId === thought.id).flatMap((l) => {
          const other = text.get(l.fromId === thought.id ? l.toId : l.fromId);
          return other ? [{ id: l.id, other, label: l.label }] : [];
        });
        const placement = thought.placement ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open') : null;
        return (
          <li key={thought.id} data-id={thought.id}>
            {editing?.id === thought.id ? (
              <ThoughtEditor className="sk-li-edit" initial={editing.initial ?? thought.text} onDone={on.onFinishEdit} />
            ) : (
              <button type="button" className="sk-li-t" data-id={thought.id} aria-pressed={selection.includes(thought.id)}
                onClick={(event) => on.onPick(thought.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canWrite && !connectFrom) { event.preventDefault(); on.onEdit(thought.id); }
                  else if (event.key === ' ') { event.preventDefault(); if (connectFrom) on.onPick(thought.id, false); else on.onToggle(thought.id); }
                  else if ((event.key === '+' || event.key === '=') && canWrite) { event.preventDefault(); on.onAdd(thought.id); }
                  else if ((event.key === 'Delete' || event.key === 'Backspace') && canWrite) { event.preventDefault(); on.onRemove(selection.includes(thought.id) ? selection : [thought.id]); }
                  else if (event.key === 'Escape' && on.onEscape()) { event.preventDefault(); event.stopPropagation(); }
                }}>
                {thought.text}
              </button>
            )}
            <span className="sk-li-s">{placement ? `${placement} · ` : ''}{provenance(thought, meId)}</span>
            {links.length ? (
              <span className="sk-li-l">Linked to {links.map((l, index) => (
                <span key={l.id}>{index ? ', ' : ''}<b>{l.other}</b>{l.label ? ` (${l.label})` : ''}</span>
              ))}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
