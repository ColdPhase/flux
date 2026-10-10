import { Fragment, type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { DEFAULT_THOUGHT_SIZE, SKETCH_LIMITS, type SketchDetail, type Thought } from '@flux/contracts';
import { Icon, IconButton, Sheet, StatusGlyph } from '../ui';
import { STATUS_LABEL, taskNumber } from '../work/format';
import { linkPath, PAD, project, rectOf, type Rect } from './geometry';
import { provenance, quote } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import { ThoughtImage } from './ThoughtImage';
import { ThoughtTasks, type ThoughtTasksEntry } from './ThoughtTasks';
import { linkOf } from './paste';
import type { Editing } from './SketchView';

/** What the floating bar above a selected thought needs from the view (the rarer actions sit behind its "…"). */
export interface SelectionTools {
  project: boolean;
  canUndo: boolean;
  helpOpen: boolean;
  onShape(): void;
  onTask(): void;
  onUndo(): void;
  onHelp(): void;
}

export interface SketchMapProps {
  /** The floating toolbar at the bottom (computer) and the line above it: hint or status. */
  dock: ReactNode;
  hint: ReactNode;
  /** Map/List remains reachable in the phone's named Map options sheet. */
  viewModes: ReactNode;
  bar: SelectionTools;
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
  /** P12: a dot was dragged onto another thought, or released on empty space at a plane position. */
  onConnect(fromId: string, toId: string): void;
  onAddAt(parentId: string, x: number, y: number): void;
  /** The dot used without a pointer (Enter or Space): the next thought chosen is linked. */
  onConnectFrom(id: string): void;
  /** S15: phones show an Add a thought button on the map itself. */
  onAddThought(): void;
  /** The single local draft that is not saved yet, shown on the map where it will land. */
  draft: { x: number; y: number; parentId: string | null } | null;
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

type Mode = 'plane' | 'compact';
/** Where a person is looking: scroll pixels on the plane; on the phone, a thought and its offset from the top. */
interface Camera { left: number; top: number; id?: string | null; whole?: boolean }
const near = (a: { left: number; top: number }, b: { left: number; top: number }) => Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1;

interface Drag {
  kind: 'move' | 'resize' | 'pan' | 'link';
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
 * Drag a thought to move it (the whole selection moves together), drag from its dot to connect (release on
 * empty space for a connected draft thought; phones only view and add, S15), drag empty space to pan,
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
  // The dot shows while the pointer is over its thought or itself (mouse only; touch shows it on the selection).
  const [hover, setHover] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [phoneMenu, setPhoneMenu] = useState<'map' | 'thought'>('map');
  const [phoneMenuOpen, setPhoneMenuOpen] = useState(false);
  const pendingPhoneAction = useRef<(() => void) | null>(null);
  // Close the modal and restore its opener before opening an editor/task panel. Otherwise
  // the sheet's focus restoration can take focus back from the newly opened surface.
  useLayoutEffect(() => {
    if (phoneMenuOpen || !pendingPhoneAction.current) return;
    const run = pendingPhoneAction.current;
    pendingPhoneAction.current = null;
    run();
  }, [phoneMenuOpen]);
  if (phoneMenuOpen && (!compact || (phoneMenu === 'thought' && (!canWrite || !selection.length || editing)))) setPhoneMenuOpen(false);
  const zoomedRef = useRef<HTMLDivElement>(null);
  /** P12: a connection being drawn from a dot; `x`,`y` are in stored plane units, `over` the thought under the pointer. */
  const [wire, setWire] = useState<{ from: string; x: number; y: number; over: string | null } | null>(null);
  // Each projection keeps its own zoom: the phone's two columns already fit at full size (#151).
  const mode: Mode = compact ? 'compact' : 'plane';
  const [zooms, setZooms] = useState<Record<Mode, number>>({ plane: 1, compact: 1 });
  const zoom = zooms[mode];
  const modeRef = useRef<Mode>(mode);
  const setZoom = useCallback((next: number | ((z: number) => number)) => setZooms((all) => {
    const key = modeRef.current;
    return { ...all, [key]: typeof next === 'function' ? next(all[key]) : next };
  }), []);
  const [, remeasure] = useState(0);
  // S15: on a phone nothing is connected or arranged; people who can write may still add and edit text.
  const arrange = canWrite && !compact;
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
  const projection = compact && canvasWidth && shown.length ? project(shown, heights, canvasWidth, null) : null;
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

  // Camera continuity (#151, ADAPT-4): the view a person chose survives resizing, rotation, the
  // keyboard and the switch between the plane and the phone's two columns. The browser clamps a
  // scroll position whenever the scrollable area shrinks (the phone projection is only as wide as
  // the canvas) and never restores it, so the map keeps its own camera per projection: the plane's
  // scroll position, and on the phone the thought at the top, its offset and the sideways scroll
  // (which only exists zoomed in). Layout changes put that camera back; only a scroll the layout
  // did not cause moves it. Nothing here auto-fits.
  const geometry = useRef({ rects, origin, zoom });
  const coarseRef = useRef(coarse);
  const cameras = useRef<Record<Mode, Camera | null>>({ plane: null, compact: null });
  const lastKnown = useRef<{ left: number; top: number } | null>(null);
  const seen = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { coarseRef.current = coarse; });
  const range = (el: HTMLElement) => ({ x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight });
  /** The scroll position a camera means in the current layout. */
  const positionOf = useCallback((camera: Camera, at: Mode) => {
    const { rects: all, origin: o, zoom: z } = geometry.current;
    if (at === 'plane') return { left: camera.left, top: camera.top };
    const r = camera.id ? all.get(camera.id) : undefined;
    // A narrower phone makes the anchored thought taller: one that was wholly in view stays so.
    const room = canvasRef.current && r ? canvasRef.current.clientHeight - r.h * z : -1;
    const offset = camera.whole && room >= 0 ? Math.min(camera.top, room) : camera.top;
    // Zoomed in, the two columns are wider than the canvas: keep the sideways place too.
    return { left: camera.left, top: Math.max(0, r ? (r.y - o.y) * z - offset : camera.top) };
  }, []);
  /** The camera for a scroll position: on the phone, the first thought in view keeps its place. */
  const cameraAt = useCallback((pos: { left: number; top: number }, at: Mode): Camera => {
    if (at === 'plane') return { left: pos.left, top: pos.top };
    const { rects: all, origin: o, zoom: z } = geometry.current;
    let best: { id: string; y: number; h: number } | null = null;
    for (const [id, r] of all) {
      const y = (r.y - o.y) * z;
      if (y + r.h * z > pos.top + 1 && (!best || y < best.y)) best = { id, y, h: r.h * z };
    }
    const height = canvasRef.current?.clientHeight ?? 0;
    return best ? { left: pos.left, top: best.y - pos.top, id: best.id, whole: best.y >= pos.top && best.y + best.h <= pos.top + height }
      : { left: pos.left, top: pos.top, id: null };
  }, []);
  const apply = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const camera = cameras.current[modeRef.current];
    if (camera) {
      const to = positionOf(camera, modeRef.current);
      el.scrollLeft = to.left;
      el.scrollTop = to.top;
    }
    lastKnown.current = { left: el.scrollLeft, top: el.scrollTop };
    seen.current = range(el);
  }, [positionOf]);
  const record = useCallback((el: HTMLElement) => {
    const pos = { left: el.scrollLeft, top: el.scrollTop };
    cameras.current[modeRef.current] = cameraAt(pos, modeRef.current);
    lastKnown.current = pos;
    seen.current = range(el);
  }, [cameraAt]);
  /** Called on scroll and when the canvas or the plane changes size. */
  const sync = useCallback((fromScroll: boolean) => {
    const el = canvasRef.current;
    if (!el) return;
    const pos = { left: el.scrollLeft, top: el.scrollTop };
    const now = range(el);
    const last = lastKnown.current;
    const resized = !seen.current || now.x !== seen.current.x || now.y !== seen.current.y;
    if (!resized) {
      // Our own placement arriving as a scroll event, or nothing new.
      if (!fromScroll || (last && near(pos, last))) return;
      record(el);
      return;
    }
    // A thought being dragged or resized changes the layout under the person's finger: the view
    // stays still instead of following the camera's anchor, which may be that very thought.
    if (drag.current?.moved && drag.current.kind !== 'pan') { record(el); return; }
    // The layout changed under the camera: unless something else scrolled at the same time
    // (a moved thought scrolled into view), the browser only clamped it.
    const clamped = last ? { left: Math.min(last.left, Math.max(0, now.x)), top: Math.min(last.top, Math.max(0, now.y)) } : null;
    if (!last || near(pos, last) || (clamped && near(pos, clamped))) apply();
    else record(el);
  }, [apply, record]);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const plane = el?.firstElementChild;
    if (!el || !plane || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => sync(false));
    ro.observe(el);
    ro.observe(plane);
    const onScroll = () => sync(true);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', onScroll); };
  }, [sync]);
  // Crossing between the plane and the phone projection: return to that projection's own camera, or
  // on a first visit keep the selected thought (else the first one in view) where the person saw it.
  useLayoutEffect(() => {
    const from = modeRef.current;
    if (from === mode) return;
    const el = canvasRef.current;
    if (el && !cameras.current[mode] && cameras.current[from]) {
      const old = geometry.current;
      const view = positionOf(cameras.current[from]!, from);
      const visible = (r: Rect) => {
        const x = (r.x - old.origin.x) * old.zoom, y = (r.y - old.origin.y) * old.zoom;
        return x + r.w * old.zoom > view.left && x < view.left + el.clientWidth && y + r.h * old.zoom > view.top && y < view.top + el.clientHeight;
      };
      const picked = selection.length ? selection[selection.length - 1]! : null;
      const pickedRect = picked ? old.rects.get(picked) : undefined;
      const first = [...old.rects].filter(([, r]) => visible(r)).sort(([, a], [, b]) => (a.y - b.y) || (a.x - b.x))[0];
      const id = pickedRect && visible(pickedRect) ? picked! : first?.[0];
      const before = id ? old.rects.get(id) : undefined;
      const after = id ? rects.get(id) : undefined;
      if (id && before && after) {
        const fit = (offset: number, room: number) => Math.max(0, Math.min(offset, room));
        const top = fit((before.y - old.origin.y) * old.zoom - view.top, el.clientHeight - after.h * zoom);
        if (mode === 'compact') cameras.current.compact = { left: 0, top, id, whole: top + after.h * zoom <= el.clientHeight };
        else {
          const left = fit((before.x - old.origin.x) * old.zoom - view.left, el.clientWidth - after.w * zoom);
          cameras.current.plane = { left: Math.max(0, (after.x - origin.x) * zoom - left), top: Math.max(0, (after.y - origin.y) * zoom - top) };
        }
      }
    }
    modeRef.current = mode;
    geometry.current = { rects, origin, zoom };
    apply();
  });
  useLayoutEffect(() => { geometry.current = { rects, origin, zoom }; });

  // Fit: show the whole graph when it fits at a readable size, otherwise start at its top left.
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const { rects: all, origin: o } = geometry.current;
    if (!canvas || !all.size) return;
    if (modeRef.current === 'compact') {
      // The projection already fits the width at full size.
      setZoom(1);
      cameras.current.compact = { left: 0, top: 0, id: null };
      requestAnimationFrame(apply);
      return;
    }
    const boxes = [...all.values()];
    const minX = Math.min(...boxes.map((r) => r.x)) - PAD;
    const minY = Math.min(...boxes.map((r) => r.y)) - PAD;
    const maxX = Math.max(...boxes.map((r) => r.x + r.w)) + PAD;
    const maxY = Math.max(...boxes.map((r) => r.y + r.h)) + PAD;
    // The canvas excludes the controls strip, including at the existing Fit zoom floor.
    // Round down so a fitted graph never grows beyond that measured viewport.
    // The floating header and tools sit over the padding of the canvas: fit what is left between them.
    const style = getComputedStyle(canvas);
    const room = canvas.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    const z = Math.max(coarseRef.current ? FIT_MIN_COARSE : FIT_MIN, Math.floor(Math.min(1, canvas.clientWidth / (maxX - minX), room / (maxY - minY)) * 100) / 100);
    setZoom(z);
    cameras.current.plane = { left: Math.max(0, (minX - o.x) * z), top: Math.max(0, (minY - o.y) * z) };
    requestAnimationFrame(apply);
  }, [apply, setZoom]);
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
    if (event.button !== 0 || editing?.id === id || !arrange) return;
    // On touch, only a selected thought drags; elsewhere a finger scrolls the map.
    if (event.pointerType !== 'mouse' && !selection.includes(id)) return;
    begin(event, { kind: 'move', id, ids: selection.includes(id) ? selection : [id] });
  };

  const onDotPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation();
    if (event.button !== 0 || !arrange) return;
    begin(event, { kind: 'link', id, ids: [id] });
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
    } else if (d.kind === 'link') {
      const box = zoomedRef.current!.getBoundingClientRect();
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.sk-node, .sk-dot, .sk-work-slot');
      const over = hit?.dataset.id ?? hit?.dataset.for ?? null;
      setWire({ from: d.id!, x: Math.max(0, Math.round((event.clientX - box.left) / zoom + origin.x)), y: Math.max(0, Math.round((event.clientY - box.top) / zoom + origin.y)), over: over && over !== d.id ? over : null });
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
    if (d.kind === 'link') {
      const end = wire;
      setWire(null);
      if (!end || !arrange) return;
      if (end.over) props.onConnect(d.id!, end.over);
      else if (!hitsDot(event, d.id!)) props.onAddAt(d.id!, end.x, Math.max(0, end.y - Math.round(DEFAULT_THOUGHT_SIZE.height / 2)));
      return;
    }
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

  /** Released back on its own dot: nothing was meant. */
  const hitsDot = (event: ReactPointerEvent, id: string) => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.sk-node, .sk-dot, .sk-work-slot');
    return (hit?.dataset.id ?? hit?.dataset.for) === id;
  };

  const onPointerCancel = () => {
    drag.current = null;
    setWire(null);
    setPanning(false);
    setOffset(null);
    setSize(null);
  };

  const onNodeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, thought: Thought) => {
    const { key } = event;
    if (key === 'Enter' || key === 'F2') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else if (canWrite) props.onEdit(thought.id); return; }
    if (key === ' ') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else props.onToggle(thought.id); return; }
    if (key === 'Escape') { if (props.onEscape()) { event.preventDefault(); event.stopPropagation(); } return; }
    if (!arrange && !canWrite) return;
    if (key === '+' || key === '=') { event.preventDefault(); props.onAdd(thought.id); return; }
    if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); props.onRemove(selection.includes(thought.id) ? selection : [thought.id]); return; }
    if (!key.startsWith('Arrow')) return;
    // Phones view and add only (S15): arrows leave the thought where it is.
    if (!arrange) return;
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

  const ghost = (x: number, y: number): Rect => ({ x, y, w: DEFAULT_THOUGHT_SIZE.width, h: DEFAULT_THOUGHT_SIZE.height });
  const wireFrom = wire ? rects.get(wire.from) : undefined;
  const draftFrom = props.draft?.parentId ? rects.get(props.draft.parentId) : undefined;
  const editingRect = editing ? rects.get(editing.id) : undefined;
  const editingThought = editing ? byId.get(editing.id) : undefined;
  const plus = last && lastThought && !editing && canWrite && !offset ? place(last) : null;
  // #252: a selected link thought offers its link; the node itself is a button, so the link sits beside it.
  const openLink = last && lastThought && !editing && !connectFrom && !offset ? linkOf(lastThought.text) : null;
  const linkAnchor = openLink ? (
    <a className="sk-edit-btn sk-open-link" href={openLink.href} target="_blank" rel="noopener noreferrer" aria-label={`Open link ${openLink.host} in a new tab`}>
      <Icon name="link" size={12} />Open link
    </a>
  ) : null;

  /** The actions of the selection float above the thought on a computer. */
  const selectionBar = (style?: CSSProperties) => {
    if (!plus || !last || !lastThought) return null;
    const single = selection.length === 1;
    const label = quote(lastThought.text);
    const close = (run: () => void) => () => { setMore(false); run(); };
      return (
        <div className="sk-actions" role="toolbar" aria-label="Selection actions" style={style}>
          {single ? <button type="button" className="sk-edit-btn" aria-label={`Edit ${label}`} onClick={() => props.onEdit(lastThought.id)}>Edit</button> : null}
          {single && !compact ? <button type="button" className="sk-edit-btn" aria-label="Connect" aria-pressed={connectFrom === lastThought.id} onClick={() => props.onConnectFrom(lastThought.id)}>Connect</button> : null}
          {linkAnchor}
          <button type="button" className={`sk-plus${coarse ? ' sk-plus--labelled' : ''}`} aria-label={`Add a thought connected to ${label}`} onClick={() => props.onAdd(lastThought.id)}>
            <Icon name="plus" size={14} />{coarse ? <span aria-hidden="true">Add</span> : null}
          </button>
          {compact && props.bar.project ? <button type="button" className="sk-edit-btn sk-edit-btn--icon" aria-label="Create task from selected thoughts" aria-disabled={false} onClick={props.bar.onTask}><Icon name="tasks" size={16} /></button> : null}
          <button type="button" className="sk-edit-btn sk-edit-btn--icon" aria-label="Remove from sketch" onClick={() => props.onRemove(selection)}><Icon name="trash" size={16} /></button>
          {compact ? null : (
            <>
              <button type="button" className="sk-edit-btn sk-edit-btn--icon" aria-label="More actions" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" size={16} /></button>
              {more ? (
                <>
                  <button type="button" className="sk-edit-btn" aria-label="Change shape" onClick={close(props.bar.onShape)}>Shape</button>
                  <button type="button" className="sk-edit-btn" aria-expanded={props.bar.helpOpen} onClick={close(props.bar.onHelp)}>Keyboard</button>
                </>
              ) : null}
            </>
          )}
        </div>
      );
  };

  const phoneAction = (run: () => void) => {
    pendingPhoneAction.current = run;
    setPhoneMenuOpen(false);
  };
  const zoomControls = (
    <div className="sk-zoom" role="group" aria-label="Zoom">
      <button type="button" className="sk-zoom__fit" aria-label="Fit the sketch to the view" onClick={fit}>Fit</button>
      <button type="button" aria-label="Zoom out" data-tip="Zoom out" disabled={zoom <= ZOOMS[0]!} onClick={() => setZoom(zoomOut(zoom))}><Icon name="minus" size={14} /></button>
      <button type="button" className="sk-zoom__level" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in" data-tip="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => setZoom(zoomIn(zoom))}><Icon name="plus" size={14} /></button>
    </div>
  );

  return (
    <div className="sk-canvas-wrap sk-canvas-wrap--controls">
    <div className={`sk-canvas${panning ? ' is-panning' : ''}${connectFrom ? ' is-connecting' : ''}${wire ? ' is-wiring' : ''}`} ref={canvasRef} role="group"
      aria-label={`Sketch: ${sketch.title}`} aria-describedby={helpId} onWheel={onWheel}>
      <div className="sk-zoomed" ref={zoomedRef} style={{ width: width * zoom, height: height * zoom }}
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
          <svg className="sk-wires" width={width} height={height} aria-hidden="true">
            {wireFrom && wire ? <path className="sk-wire" d={linkPath({ ...wireFrom, ...place(wireFrom) }, wire.over && rects.get(wire.over) ? { ...rects.get(wire.over)!, ...place(rects.get(wire.over)!) } : { ...ghost(wire.x, wire.y), x: wire.x - origin.x, y: wire.y - origin.y }).d} /> : null}
            {draftFrom && props.draft ? <path className="sk-wire" d={linkPath({ ...draftFrom, ...place(draftFrom) }, { ...ghost(props.draft.x, props.draft.y), x: props.draft.x - origin.x, y: props.draft.y - origin.y }).d} /> : null}
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
            const link = linkOf(thought.text);
            const meta = thought.placement
              ? (thought.placement.title ? `Draft · ${thought.placement.title}` : 'Draft you can’t open')
              : link ? `Link · ${link.host}` : null;
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
                onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHover(thought.id); }}
                onPointerLeave={() => setHover((id) => id === thought.id ? null : id)}
                onKeyDown={(event) => onNodeKeyDown(event, thought)}>
                {meta ? <span className="sk-k"><Icon name={thought.placement ? 'doc' : 'link'} size={12} />{meta}</span> : null}
                {thought.file ? <ThoughtImage className="sk-img" fileId={thought.file.id} name={thought.file.name}
                  style={{ maxHeight: Math.max(48, thought.height - 64) }} /> : null}
                <span className={`sk-t${link ? ' sk-t--link' : ''}`}>{thought.text}</span>
                <span className="sk-p">{provenance(thought, meId)}</span>
                {/* A thought that became a task shows its status, number and owner (F-026). */}
                {linked?.tasks[0] ? <span className="sk-taskline"><StatusGlyph status={linked.tasks[0].status} size={14} />
                  <span>{taskNumber(linked.tasks[0])} {STATUS_LABEL[linked.tasks[0].status]}{linked.tasks[0].owner ? ` · ${linked.tasks[0].owner.name}` : ''}</span></span> : null}
                {/* Room for the count, which is its own button beside this one. */}
                {linked?.count ? <span className="sk-work-gap" aria-hidden="true" /> : null}
                {selected && selection.length === 1 && arrange && !coarse && !editing ? (
                  <span className="sk-resize" aria-hidden="true" onPointerDown={(event) => onResizePointerDown(event, thought)} />
                ) : null}
              </button>
              {linked?.count && projectId ? (
                <div className={`sk-work-slot sk-work-slot--${thought.shape}${dragging ? ' is-dragging' : ''}`} data-for={thought.id} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: r.w, height: r.h }}>
                  <ThoughtTasks thought={thought} tasks={linked} projectId={projectId} variant="map" onOpenTask={props.onOpenTask} />
                </div>
              ) : null}
              {arrange && !editing && !measuring ? (['right', 'left'] as const).map((side) => (
                <button key={side} type="button" tabIndex={selected && side === 'right' ? 0 : -1} data-for={thought.id} data-side={side}
                  aria-label={`Connect from ${quote(thought.text)}: drag to another thought, or press Enter and choose one`} aria-hidden={side === 'left' ? true : undefined}
                  onPointerEnter={() => setHover(thought.id)} onPointerLeave={() => setHover((id) => id === thought.id ? null : id)}
                  className={`sk-dot${selected || connectFrom === thought.id || hover === thought.id ? ' is-on' : ''}${dragging ? ' is-dragging' : ''}`}
                  style={{ transform: `translate(${p.x + (side === 'right' ? r.w : 0)}px, ${p.y + r.h / 2}px) scale(${1 / zoom}) translate(-50%, -50%)` }}
                  onPointerDown={(event) => onDotPointerDown(event, thought.id)}
                  onClick={() => { if (!suppressClick.current) props.onConnectFrom(thought.id); }} />
              )) : null}
              </Fragment>
            );
          })}
          {plus && last && lastThought ? (!compact ? (() => {
            // Controls keep their on-screen size at every zoom (touch targets stay 44px).
            const x = plus.x + last.w / 2;
            const keep = `scale(${1 / zoom})`;
            const at = plus.y < 56 ? `translate(${x}px, ${plus.y + last.h + 8}px) ${keep} translateX(-50%)` : `translate(${x}px, ${plus.y - 8}px) ${keep} translate(-50%, -100%)`;
            return selectionBar({ transform: at });
          })() : null) : linkAnchor && last ? (() => {
            // People who can only look still open a selected link.
            const at = place(last);
            return <div className="sk-actions" style={{ transform: `translate(${at.x + last.w / 2}px, ${at.y + last.h + 6}px) scale(${1 / zoom}) translateX(-50%)` }}>{linkAnchor}</div>;
          })() : null}
          {wire && !wire.over && wireFrom ? (
            <>
              <div className="sk-ghost" aria-hidden="true" style={{ transform: `translate(${wire.x - origin.x}px, ${wire.y - origin.y}px)`, width: DEFAULT_THOUGHT_SIZE.width, height: DEFAULT_THOUGHT_SIZE.height }}>New thought</div>
              <p className="sk-ghost__hint" aria-hidden="true" style={{ transform: `translate(${wire.x - origin.x}px, ${wire.y - origin.y + DEFAULT_THOUGHT_SIZE.height + 6}px)` }}>Release to add a connected thought</p>
            </>
          ) : null}
          {props.draft ? (
            <div className="sk-ghost sk-ghost--draft" aria-hidden="true" style={{ transform: `translate(${props.draft.x - origin.x}px, ${props.draft.y - origin.y}px)`, width: DEFAULT_THOUGHT_SIZE.width, height: DEFAULT_THOUGHT_SIZE.height }}>Draft · not saved</div>
          ) : null}
          {editing && editingRect && editingThought && canWrite ? (
            <ThoughtEditor key={`${editing.id}:${editing.attempt}`} className="sk-edit" initial={editing.initial} disabled={editing.saving} onChange={props.onEditText}
              style={{ transform: `translate(${place(editingRect).x + 6}px, ${place(editingRect).y + 6}px)`, width: editingRect.w - 12 }}
              onDone={props.onFinishEdit} />
          ) : null}
        </div>
      </div>
    </div>
      <div className="sk-dock">
        {props.hint}
        <div className="sk-dock__row">
          {props.dock}
          {!compact ? zoomControls : null}
        </div>
      </div>
      {compact ? <button type="button" className="sk-edit-btn sk-map-options" aria-haspopup="dialog" aria-expanded={phoneMenuOpen && phoneMenu === 'map'} onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true }); setPhoneMenu('map'); setPhoneMenuOpen(true);
      }}><Icon name="more" size={16} />Map options</button> : null}
      {compact && canWrite ? (
        <div className="sk-phone">
          <div className="sk-phone__secondary">
            {plus ? <button type="button" className="sk-edit-btn" aria-haspopup="dialog" aria-expanded={phoneMenuOpen && phoneMenu === 'thought'} onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true }); setPhoneMenu('thought'); setPhoneMenuOpen(true);
            }}><Icon name="more" size={16} />Thought actions</button> : null}
            {props.bar.canUndo ? <button type="button" className="sk-undo" aria-label="Undo" onClick={props.bar.onUndo}><Icon name="undo" size={16} />Undo</button> : null}
          </div>
          <p className="sk-phone__note"><Icon name="monitor" size={16} />Connect and arrange on a computer</p>
          <button type="button" className="sk-fab sk-add" onClick={props.onAddThought}><Icon name="plus" size={18} />Add a thought</button>
        </div>
      ) : null}
      {compact ? <Sheet open={phoneMenuOpen} onClose={() => setPhoneMenuOpen(false)} label={phoneMenu === 'thought' ? 'Thought actions' : 'Map options'} className="sk-options-sheet">
        <div className="ui-panel__head">
          <h2 className="ui-panel__title">{phoneMenu === 'thought' ? 'Thought actions' : 'Map options'}</h2>
          <IconButton icon="x" label={phoneMenu === 'thought' ? 'Close thought actions' : 'Close map options'} className="ui-panel__close" onClick={() => setPhoneMenuOpen(false)} />
        </div>
        <div className="ui-panel__body">
          {phoneMenu === 'thought' && lastThought ? <>
            <p className="sk-options__thought">{lastThought.text}</p>
            <button type="button" className="sk-options__action" onClick={() => phoneAction(() => props.onEdit(lastThought.id))}><Icon name="edit" size={18} />Edit thought</button>
            {openLink ? <a className="sk-options__action" href={openLink.href} target="_blank" rel="noopener noreferrer"><Icon name="link" size={18} />Open link {openLink.host}</a> : null}
            <button type="button" className="sk-options__action" onClick={() => phoneAction(() => props.onAdd(lastThought.id))}><Icon name="plus" size={18} />Add a connected thought</button>
            {props.bar.project ? <button type="button" className="sk-options__action" aria-label="Create task from selected thoughts" onClick={() => phoneAction(props.bar.onTask)}><Icon name="tasks" size={18} />Create task</button> : null}
            <button type="button" className="sk-options__action" aria-label="Remove from sketch" onClick={() => phoneAction(() => props.onRemove(selection))}><Icon name="trash" size={18} />Remove thought</button>
          </> : <>
            <p className="sk-options__thought">{sketch.title}</p>
            <div onClick={(event) => { if ((event.target as HTMLElement).closest('[role="radio"]')) setPhoneMenuOpen(false); }}>{props.viewModes}</div>
            {zoomControls}
          </>}
        </div>
      </Sheet> : null}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
