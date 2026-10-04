import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { SKETCH_LIMITS, type SketchDetail, type Thought } from '@flux/contracts';
import { Icon } from '../ui';
import { linkPath, PAD, project, rectOf, type Rect } from './geometry';
import { provenance, quote } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import { ThoughtTasks, type ThoughtTasksEntry } from './ThoughtTasks';
import type { Editing } from './SketchView';

export interface SketchMapProps {
  sketch: SketchDetail;
  meId: string;
  selection: string[];
  connectFrom: string | null;
  editing: Editing | null;
  coarse: boolean;
  /** Phone width: the two-column projection instead of free plane positions. */
  compact: boolean;
  helpId: string;
  /** Measured heights of the rendered thoughts, shared with the view for placing new ones. */
  heights: Map<string, number>;
  canWrite: boolean;
  /** The project's tasks linked to each thought (UI116-4); none outside a project. */
  tasks: Map<string, ThoughtTasksEntry>;
  projectId: string | null;
  onOpenTask(id: string): void;
  onPick(id: string, additive: boolean): void;
  onToggle(id: string): void;
  onClear(): void;
  onEdit(id: string): void;
  onEditText(text: string): void;
  onFinishEdit(text: string | null): void;
  onAdd(parentId: string | null): void;
  onMove(moves: { id: string; x: number; y: number }[], how: 'drag' | 'keyboard'): void;
  onResize(id: string, width: number, height: number, how: 'drag' | 'keyboard'): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
/** Fitting never shrinks text below a readable size; wider sketches keep their scroll. */
const FIT_MIN = 0.6;
/** On touch screens text stays larger; the rest of a wide sketch is a swipe away. */
const FIT_MIN_COARSE = 0.75;
const zoomIn = (z: number) => ZOOMS.find((step) => step > z + 0.001) ?? ZOOMS[ZOOMS.length - 1]!;
const zoomOut = (z: number) => [...ZOOMS].reverse().find((step) => step < z - 0.001) ?? ZOOMS[0]!;

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
  const { sketch, meId, selection, connectFrom, editing, coarse, compact, helpId, heights, canWrite, tasks, projectId } = props;
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
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCanvasWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const projection = compact && canvasWidth && shown.length ? project(shown, heights, canvasWidth, selection.length && canWrite && !editing ? { id: selection[selection.length - 1]!, below: 58 } : null) : null;
  // On a phone nothing is drawn until the width is known, so thoughts never slide in from the plane layout.
  const measuring = compact && !canvasWidth;
  const rects = projection ? projection.rects : new Map<string, Rect>(shown.map((t) => [t.id, rectOf(t, heights)]));
  const scaleX = projection?.scaleX ?? 1;
  const origin = { x: Math.min(0, ...[...rects.values()].map((r) => r.x - PAD)), y: Math.min(0, ...[...rects.values()].map((r) => r.y - PAD)) };
  let width = 0;
  let height = 0;
  for (const r of rects.values()) { width = Math.max(width, r.x + r.w - origin.x); height = Math.max(height, r.y + r.h - origin.y); }
  // Room to keep sketching beyond the last thought.
  width += projection ? 0 : 240;
  height += 160;
  const place = (r: Rect) => ({ x: r.x - origin.x, y: r.y - origin.y });
  const last = selection.length ? rects.get(selection[selection.length - 1]!) : undefined;
  const lastThought = selection.length ? shown.find((t) => t.id === selection[selection.length - 1]) : undefined;
  const byId = new Map(shown.map((t) => [t.id, t]));

  // Fit: show the whole graph when it fits at a readable size, otherwise start at its top left.
  const geometry = useRef({ rects, origin });
  const coarseRef = useRef(coarse);
  const compactRef = useRef(compact);
  useEffect(() => { coarseRef.current = coarse; compactRef.current = compact; });
  useEffect(() => { geometry.current = { rects, origin }; });
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const { rects: all, origin: o } = geometry.current;
    if (!canvas || !all.size) return;
    if (compactRef.current) {
      // The projection already fits the width at full size.
      setZoom(1);
      requestAnimationFrame(() => { canvas.scrollLeft = 0; canvas.scrollTop = 0; });
      return;
    }
    const boxes = [...all.values()];
    const minX = Math.min(...boxes.map((r) => r.x)) - PAD;
    const minY = Math.min(...boxes.map((r) => r.y)) - PAD;
    const maxX = Math.max(...boxes.map((r) => r.x + r.w)) + PAD;
    const maxY = Math.max(...boxes.map((r) => r.y + r.h)) + PAD;
    // The canvas excludes the controls strip, including at the existing Fit zoom floor.
    // Round down so a fitted graph never grows beyond that measured viewport.
    const z = Math.max(coarseRef.current ? FIT_MIN_COARSE : FIT_MIN, Math.floor(Math.min(1, canvas.clientWidth / (maxX - minX), canvas.clientHeight / (maxY - minY)) * 100) / 100);
    setZoom(z);
    requestAnimationFrame(() => {
      canvas.scrollLeft = Math.max(0, (minX - o.x) * z);
      canvas.scrollTop = Math.max(0, (minY - o.y) * z);
    });
  }, []);
  const fitted = useRef(false);
  const hasThoughts = sketch.thoughts.length > 0;
  useEffect(() => {
    if (fitted.current || !hasThoughts) return;
    fitted.current = true;
    fit();
  }, [hasThoughts, fit]);
  const highlighted = (id: string) => selection.includes(id) || connectFrom === id;

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom((z) => (event.deltaY < 0 ? zoomIn(z) : zoomOut(z)));
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
      // Offsets are in stored plane units; the phone projection compresses x.
      setOffset({ ids: d.ids, dx: Math.round(dx * scaleX), dy: Math.round(dy) });
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
    if (key === 'Enter' || key === 'F2') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else if (canWrite) props.onEdit(thought.id); return; }
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

  const editingRect = editing ? rects.get(editing.id) : undefined;
  const editingThought = editing ? byId.get(editing.id) : undefined;
  const plus = last && lastThought && !editing && !connectFrom && canWrite && !offset ? place(last) : null;

  return (
    <div className="sk-canvas-wrap sk-canvas-wrap--controls">
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
          {measuring ? null : shown.map((thought) => {
            const r = rects.get(thought.id)!;
            const p = place(r);
            const selected = selection.includes(thought.id);
            const dragging = !!offset?.ids.includes(thought.id);
            const meta = thought.placement
              ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open')
              : null;
            // UI116-4: a count of the linked tasks, never their titles or results, under the text.
            const linked = projectId ? tasks.get(thought.id) : undefined;
            return (
              <Fragment key={thought.id}>
              <button type="button" data-id={thought.id}
                ref={(el) => {
                  if (el) { nodes.current.set(thought.id, el); observer.current?.observe(el); return () => { nodes.current.delete(thought.id); observer.current?.unobserve(el); }; }
                }}
                className={`sk-node sk-node--${thought.shape}${dragging ? ' is-dragging' : ''}${editing?.id === thought.id ? ' is-editing' : ''}${thought.version === 0 ? ' is-new' : ''}${linked?.count ? ' has-work' : ''}`}
                style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: r.w, minHeight: thought.shape === 'circle' ? r.w : thought.height, height: thought.shape === 'circle' ? r.w : undefined }}
                aria-pressed={selected} aria-describedby={helpId}
                onPointerDown={(event) => onNodePointerDown(event, thought.id)}
                onClick={(event) => { if (suppressClick.current) return; props.onPick(thought.id, event.shiftKey || event.metaKey || event.ctrlKey); }}
                onDoubleClick={() => { if (canWrite && !connectFrom) props.onEdit(thought.id); }}
                onKeyDown={(event) => onNodeKeyDown(event, thought)}>
                {meta ? <span className="sk-k"><Icon name="doc" size={12} />{meta}</span> : null}
                <span className="sk-t">{thought.text}</span>
                <span className="sk-p">{provenance(thought, meId)}</span>
                {/* Room for the count, which is its own button beside this one. */}
                {linked?.count ? <span className="sk-work-gap" aria-hidden="true" /> : null}
                {selected && selection.length === 1 && canWrite && !coarse && !editing ? (
                  <span className="sk-resize" aria-hidden="true" onPointerDown={(event) => onResizePointerDown(event, thought)} />
                ) : null}
              </button>
              {linked?.count && projectId ? (
                <div className={`sk-work-slot sk-work-slot--${thought.shape}${dragging ? ' is-dragging' : ''}`} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: r.w, height: r.h }}>
                  <ThoughtTasks thought={thought} tasks={linked} projectId={projectId} variant="map" onOpenTask={props.onOpenTask} />
                </div>
              ) : null}
              </Fragment>
            );
          })}
          {plus && last && lastThought ? (() => {
            // Controls keep their on-screen size at every zoom (touch targets stay 44px).
            const keep = `scale(${1 / zoom})`;
            const add = (
              <button type="button" className={`sk-plus${coarse ? ' sk-plus--labelled' : ''}`} aria-label={`Add a thought connected to ${quote(lastThought.text)}`} onClick={() => props.onAdd(lastThought.id)}>
                <Icon name="plus" size={14} />{coarse ? <span aria-hidden="true">Add</span> : null}
              </button>
            );
            const edit = (
              <button type="button" className="sk-edit-btn" aria-label={`Edit ${quote(lastThought.text)}`} onClick={() => props.onEdit(lastThought.id)}>Edit</button>
            );
            return coarse ? (
              <div className="sk-actions" style={{ transform: `translate(${plus.x + last.w / 2}px, ${plus.y + last.h + 6}px) ${keep} translateX(-50%)` }}>{edit}{add}</div>
            ) : (
              // With a fine pointer, Edit sits in the toolbar so nothing covers nearby thoughts.
              <div className="sk-actions" style={{ transform: `translate(${plus.x + last.w + 8}px, ${plus.y + last.h / 2}px) ${keep} translateY(-50%)` }}>{add}</div>
            );
          })() : null}
          {editing && editingRect && editingThought && canWrite ? (
            <ThoughtEditor key={`${editing.id}:${editing.attempt}`} className="sk-edit" initial={editing.initial} disabled={editing.saving} onChange={props.onEditText}
              style={{ transform: `translate(${place(editingRect).x + 6}px, ${place(editingRect).y + 6}px)`, width: editingRect.w - 12 }}
              onDone={props.onFinishEdit} />
          ) : null}
        </div>
      </div>
    </div>
      <div className="sk-zoom" role="group" aria-label="Zoom">
        <button type="button" className="sk-zoom__fit" aria-label="Fit the sketch to the view" onClick={fit}>Fit</button>
        <button type="button" aria-label="Zoom out" data-tip="Zoom out" disabled={zoom <= ZOOMS[0]!} onClick={() => setZoom(zoomOut(zoom))}><Icon name="minus" size={14} /></button>
        <button type="button" className="sk-zoom__level" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" data-tip="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => setZoom(zoomIn(zoom))}><Icon name="plus" size={14} /></button>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
