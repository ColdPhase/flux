import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { SKETCH_LIMITS, type SketchDetail, type Thought } from '@flux/contracts';
import { Icon } from '../ui';
import { linkPath, PAD, rectOf, type Rect } from './geometry';
import { provenance, quote } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import type { Editing } from './SketchView';

export interface SketchMapProps {
  sketch: SketchDetail;
  meId: string;
  selection: string[];
  connectFrom: string | null;
  editing: Editing | null;
  coarse: boolean;
  helpId: string;
  /** Measured heights of the rendered thoughts, shared with the view for placing new ones. */
  heights: Map<string, number>;
  canWrite: boolean;
  onPick(id: string, additive: boolean): void;
  onToggle(id: string): void;
  onClear(): void;
  onEdit(id: string): void;
  onFinishEdit(text: string | null): void;
  onAdd(parentId: string | null): void;
  onMove(moves: { id: string; x: number; y: number }[], how: 'drag' | 'keyboard'): void;
  onResize(id: string, width: number, height: number, how: 'drag' | 'keyboard'): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

interface Drag {
  kind: 'move' | 'resize' | 'pan';
  id?: string;
  ids: string[];
  pointerId: number;
  sx: number;
  sy: number;
  moved: boolean;
  scrollLeft?: number;
  scrollTop?: number;
}

/**
 * The Map: thoughts on a dotted plane with soft curved links (direction C, `#lamp-map`).
 * Drag a thought to move it (the whole selection moves together), drag empty space to pan,
 * Ctrl/⌘-wheel or the corner controls to zoom. Every pointer action has a keyboard path on a
 * focused thought. Nothing here opens a panel: selecting only highlights and shows the "+".
 */
export function SketchMap(props: SketchMapProps) {
  const { sketch, meId, selection, connectFrom, editing, coarse, helpId, heights, canWrite } = props;
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState<{ ids: string[]; dx: number; dy: number } | null>(null);
  const [size, setSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [, remeasure] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  // Measure rendered heights so links attach to the real edges of each thought.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const id = el.dataset.id;
        const h = el.offsetHeight;
        if (id && h && heights.get(id) !== h) { heights.set(id, h); changed = true; }
      }
      if (changed) remeasure((n) => n + 1);
    });
    observer.current = ro;
    for (const el of nodes.current.values()) ro.observe(el);
    return () => { ro.disconnect(); observer.current = null; };
  }, [heights]);

  const shown = useMemo(() => sketch.thoughts.map((t): Thought => {
    let next = t;
    if (offset?.ids.includes(t.id)) next = { ...next, x: Math.max(0, t.x + offset.dx), y: Math.max(0, t.y + offset.dy) };
    if (size?.id === t.id) next = { ...next, width: size.w, height: size.h };
    return next;
  }), [sketch.thoughts, offset, size]);
  const rects = new Map<string, Rect>(shown.map((t) => [t.id, rectOf(t, heights)]));
  const origin = { x: Math.min(0, ...[...rects.values()].map((r) => r.x - PAD)), y: Math.min(0, ...[...rects.values()].map((r) => r.y - PAD)) };
  let width = 0;
  let height = 0;
  for (const r of rects.values()) { width = Math.max(width, r.x + r.w - origin.x); height = Math.max(height, r.y + r.h - origin.y); }
  // Room to keep sketching beyond the last thought.
  width += 240;
  height += 160;
  const place = (r: Rect) => ({ x: r.x - origin.x, y: r.y - origin.y });
  const last = selection.length ? rects.get(selection[selection.length - 1]!) : undefined;
  const lastThought = selection.length ? shown.find((t) => t.id === selection[selection.length - 1]) : undefined;
  const byId = new Map(shown.map((t) => [t.id, t]));
  const highlighted = (id: string) => selection.includes(id) || connectFrom === id;

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + (event.deltaY < 0 ? 1 : -1)))]!);
  };
  // React's wheel listener is passive; Ctrl-wheel must be cancellable to replace the browser zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const block = (event: globalThis.WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
  }, []);

  const begin = (event: ReactPointerEvent, next: Omit<Drag, 'pointerId' | 'sx' | 'sy' | 'moved'>) => {
    drag.current = { ...next, pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, moved: false };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || editing?.id === id || !canWrite) return;
    // On touch, only a selected thought drags; elsewhere a finger scrolls the map.
    if (event.pointerType !== 'mouse' && !selection.includes(id)) return;
    begin(event, { kind: 'move', id, ids: selection.includes(id) ? selection : [id] });
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLSpanElement>, thought: Thought) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    begin(event, { kind: 'resize', id: thought.id, ids: [thought.id] });
  };

  const onPlanePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const empty = target === event.currentTarget || target.classList.contains('sk-plane');
    if (event.button !== 0 || !empty || event.pointerType !== 'mouse') return;
    const canvas = canvasRef.current!;
    begin(event, { kind: 'pan', ids: [], scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = (event.clientX - d.sx) / zoom;
    const dy = (event.clientY - d.sy) / zoom;
    if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (d.kind === 'move' && !selection.includes(d.id!)) props.onPick(d.id!, false);
      if (d.kind === 'pan') setPanning(true);
    }
    if (d.kind === 'pan') {
      const canvas = canvasRef.current!;
      canvas.scrollLeft = d.scrollLeft! - (event.clientX - d.sx);
      canvas.scrollTop = d.scrollTop! - (event.clientY - d.sy);
    } else if (d.kind === 'move') {
      setOffset({ ids: d.ids, dx: Math.round(dx), dy: Math.round(dy) });
    } else {
      const t = byId.get(d.id!) ?? sketch.thoughts.find((x) => x.id === d.id);
      const base = sketch.thoughts.find((x) => x.id === d.id) ?? t!;
      setSize({ id: d.id!, w: clamp(Math.round(base.width + dx), SKETCH_LIMITS.minWidth, SKETCH_LIMITS.maxWidth), h: clamp(Math.round(Math.max(base.height, heights.get(base.id) ?? 0) + dy), SKETCH_LIMITS.minHeight, SKETCH_LIMITS.maxHeight) });
    }
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (d.kind === 'pan') {
      if (!d.moved) props.onClear();
      return;
    }
    if (!d.moved) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    if (d.kind === 'move' && offset) {
      props.onMove(d.ids.flatMap((id) => {
        const t = sketch.thoughts.find((x) => x.id === id);
        return t ? [{ id, x: Math.max(0, t.x + offset.dx), y: Math.max(0, t.y + offset.dy) }] : [];
      }), 'drag');
    }
    if (d.kind === 'resize' && size) props.onResize(size.id, size.w, size.h, 'drag');
    setOffset(null);
    setSize(null);
  };

  const onPointerCancel = () => {
    drag.current = null;
    setPanning(false);
    setOffset(null);
    setSize(null);
  };

  const onNodeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, thought: Thought) => {
    const { key } = event;
    if (key === 'Enter') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else if (canWrite) props.onEdit(thought.id); return; }
    if (key === ' ') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else props.onToggle(thought.id); return; }
    if (key === 'Escape') { if (props.onEscape()) { event.preventDefault(); event.stopPropagation(); } return; }
    if (!canWrite) return;
    if (key === '+' || key === '=') { event.preventDefault(); props.onAdd(thought.id); return; }
    if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); props.onRemove(selection.includes(thought.id) ? selection : [thought.id]); return; }
    if (!key.startsWith('Arrow')) return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 12;
    const [dx, dy] = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[key] ?? [0, 0];
    if (event.altKey) {
      // Alt + arrows resize the focused thought.
      const h = Math.max(thought.height, heights.get(thought.id) ?? 0);
      props.onResize(thought.id, clamp(thought.width + dx, SKETCH_LIMITS.minWidth, SKETCH_LIMITS.maxWidth), clamp(h + dy, SKETCH_LIMITS.minHeight, SKETCH_LIMITS.maxHeight), 'keyboard');
      return;
    }
    const ids = selection.includes(thought.id) ? selection : [thought.id];
    if (!selection.includes(thought.id)) props.onPick(thought.id, false);
    props.onMove(ids.flatMap((id) => {
      const t = sketch.thoughts.find((x) => x.id === id);
      return t ? [{ id, x: Math.max(0, t.x + dx), y: Math.max(0, t.y + dy) }] : [];
    }), 'keyboard');
    requestAnimationFrame(() => nodes.current.get(thought.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };

  // Keep a newly added thought in view.
  useEffect(() => {
    if (editing?.isNew) nodes.current.get(editing.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [editing]);

  const editingRect = editing ? rects.get(editing.id) : undefined;
  const editingThought = editing ? byId.get(editing.id) : undefined;
  const plus = last && lastThought && !editing && !connectFrom && canWrite && !offset ? place(last) : null;
  const plusSize = coarse ? 44 : 28;

  return (
    <div className="sk-canvas-wrap">
    <div className={`sk-canvas${panning ? ' is-panning' : ''}${connectFrom ? ' is-connecting' : ''}`} ref={canvasRef} role="group"
      aria-label={`Sketch: ${sketch.title}`} aria-describedby={helpId} onWheel={onWheel}>
      <div className="sk-zoomed" style={{ width: width * zoom, height: height * zoom }}
        onPointerDown={onPlanePointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
        <div className="sk-plane" style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
          <svg className="sk-edges" width={width} height={height} aria-hidden="true">
            {sketch.links.map((link) => {
              const a = rects.get(link.fromId);
              const b = rects.get(link.toId);
              if (!a || !b) return null;
              const { d } = linkPath({ ...a, ...place(a) }, { ...b, ...place(b) });
              const on = highlighted(link.fromId) || highlighted(link.toId);
              return <path key={link.id} d={d} className={on ? 'is-on' : undefined} />;
            })}
          </svg>
          <div className="sk-labels" aria-hidden="true">
            {sketch.links.map((link) => {
              const a = rects.get(link.fromId);
              const b = rects.get(link.toId);
              if (!a || !b || !link.label) return null;
              const { mid } = linkPath({ ...a, ...place(a) }, { ...b, ...place(b) });
              const on = highlighted(link.fromId) || highlighted(link.toId);
              return <span key={link.id} className={`sk-el${on ? ' is-on' : ''}`} style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)` }}>{link.label}</span>;
            })}
          </div>
          {shown.map((thought) => {
            const r = rects.get(thought.id)!;
            const p = place(r);
            const selected = selection.includes(thought.id);
            const dragging = !!offset?.ids.includes(thought.id);
            const meta = thought.placement
              ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open')
              : null;
            return (
              <button key={thought.id} type="button" data-id={thought.id}
                ref={(el) => {
                  if (el) { nodes.current.set(thought.id, el); observer.current?.observe(el); return () => { nodes.current.delete(thought.id); observer.current?.unobserve(el); }; }
                }}
                className={`sk-node sk-node--${thought.shape}${dragging ? ' is-dragging' : ''}${editing?.id === thought.id ? ' is-editing' : ''}${thought.version === 0 ? ' is-new' : ''}`}
                style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: thought.width, minHeight: thought.shape === 'circle' ? thought.width : thought.height, height: thought.shape === 'circle' ? thought.width : undefined }}
                aria-pressed={selected} aria-describedby={helpId}
                onPointerDown={(event) => onNodePointerDown(event, thought.id)}
                onClick={(event) => { if (suppressClick.current) return; props.onPick(thought.id, event.shiftKey || event.metaKey || event.ctrlKey); }}
                onDoubleClick={() => { if (canWrite && !connectFrom) props.onEdit(thought.id); }}
                onKeyDown={(event) => onNodeKeyDown(event, thought)}>
                {meta ? <span className="sk-k"><Icon name="doc" size={12} />{meta}</span> : null}
                <span className="sk-t">{thought.text}</span>
                <span className="sk-p">{provenance(thought, meId)}</span>
                {selected && selection.length === 1 && canWrite && !coarse && !editing ? (
                  <span className="sk-resize" aria-hidden="true" onPointerDown={(event) => onResizePointerDown(event, thought)} />
                ) : null}
              </button>
            );
          })}
          {plus && last ? (
            <button type="button" className="sk-plus" aria-label={`Add a thought connected to ${quote(lastThought!.text)}`}
              style={{ transform: coarse ? `translate(${plus.x + last.w / 2 - plusSize / 2}px, ${plus.y + last.h + 6}px)` : `translate(${plus.x + last.w + 8}px, ${plus.y + last.h / 2 - plusSize / 2}px)` }}
              onClick={() => props.onAdd(lastThought!.id)}>
              <Icon name="plus" size={14} />
            </button>
          ) : null}
          {editing && editingRect && editingThought ? (
            <ThoughtEditor key={editing.id} className="sk-edit" initial={editing.initial ?? editingThought.text}
              style={{ transform: `translate(${place(editingRect).x + 6}px, ${place(editingRect).y + 6}px)`, width: editingRect.w - 12 }}
              onDone={props.onFinishEdit} />
          ) : null}
        </div>
      </div>
    </div>
      <div className="sk-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" data-tip="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}><Icon name="minus" size={14} /></button>
        <button type="button" className="sk-zoom__level" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" data-tip="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}><Icon name="plus" size={14} /></button>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
