import { Fragment, memo, type CSSProperties, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { MapPresenceSource } from '../editing/map-presence';
import { MapCursors, MapPeople } from './MapPresence';
import { DEFAULT_THOUGHT_SIZE, SKETCH_LIMITS, type LiveMapPosition, type SketchDetail, type Thought } from '@flux/contracts';
import { Icon, IconButton, Sheet, StatusGlyph } from '../ui';
import { STATUS_LABEL, taskNumber } from '../work/format';
import { linkPath, PAD, PLANE_MARGIN, project, rectOf, type Rect } from './geometry';
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
  /** Cite the selected thought in its place's conversation (#469); absent where a sketch has none. */
  onCite: (() => void) | null;
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
  /** Plane origin follows native positions, before transient previews and a local drag. */
  confirmedThoughts: Thought[] | null;
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
  /** The tallest the bottom toolbar and its line have been, kept by the view across Map and List (#510), and how the map raises it. */
  dockHeight: number;
  onDockHeight(update: (before: number) => number): void;
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
  onLabel(linkId: string): void;
  onConnections(thoughtId: string): void;
  /** S15: phones show an Add a thought button on the map itself. */
  onAddThought(): void;
  /** The single local draft that is not saved yet, shown on the map where it will land. */
  draft: { x: number; y: number; parentId: string | null; label: string } | null;
  /** Private composition sits beside visible map context, outside the scrolling plane. */
  draftEditor: ((focusReady: boolean) => ReactNode) | null;
  onMove(moves: { id: string; x: number; y: number }[], how: 'drag' | 'keyboard'): void;
  onResize(id: string, width: number, height: number, how: 'drag' | 'keyboard'): void;
  onRemove(ids: string[]): void;
  onEscape(): boolean;
  onGestureStart(ids: string[]): boolean;
  onGesturePreview(positions: LiveMapPosition[]): void;
  onGestureCancel(): void;
  movers: Map<string, string>;
  /** Other people on this map: a named, coloured cursor each, and the "who is here" chip. */
  presenceStore: MapPresenceSource | null;
  onPointer(point: { x: number; y: number } | null): void;
  livePreviews: Map<string, { generation: string; gestureId: string; leaseId: string; sequence: number }>;
  ownGesture: { id: string; sequence: number; generation: string } | null | undefined;
  liveEnabled: boolean;
  /** The hand tool (#509 AC-1): dragging anywhere pans the plane, thoughts included. */
  hand: boolean;
}

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
/** A map at most this wide (CSS px) shows its thoughts in the two columns, on any device (#151 AC-1). */
const NARROW_MAP = 640;
/** Fitting never shrinks text below a readable size; wider sketches keep their scroll. */
const FIT_MIN = 0.6;
/** On touch screens text stays larger; the rest of a wide sketch is a swipe away. */
const FIT_MIN_COARSE = 0.75;
/** The map opens at a working size (#726): a thought's title at 12.6 px or more and its meta line at 10.8 px or more
 *  (90% of 14 and 12 px), as the map is drawn. A larger sketch opens at its top left and Fit is the overview. */
const OPEN_MIN = 0.9;
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
  /** Selection-only pointer clicks own no live lease. */
  started: boolean;
  scrollLeft?: number;
  scrollTop?: number;
  base: Thought[];
  /** Intrinsic/native minimum at pointer-down, before our own previews can change measured height. */
  resizeHeight?: number;
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
  const hasComposition = !!props.draftEditor;
  const canvasRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  const [compositionHeight, setCompositionHeight] = useState(240);
  const [compositionPosition, setCompositionPosition] = useState<{ left: number; top: number } | null>(null);
  const phoneToolsRef = useRef<HTMLDivElement>(null);
  // The zoom and minimap rise above the bottom toolbar and its line where the pane is too narrow for
  // them beside it. The tallest height seen keeps them clear however the toolbar or the hint wraps,
  // and they only ever move up once, not with every status line (Spokój rule 7). The view keeps that
  // height (a Map, List, Map round trip mounts the map again) and it is read before the first paint,
  // so a map that has just been mounted never shows them at a place they leave a frame later (#510).
  const dockRef = useRef<HTMLDivElement>(null);
  const { dockHeight, onDockHeight } = props;
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (compact || !el) return;
    const measure = () => { const h = Math.ceil(el.getBoundingClientRect().height); onDockHeight((before) => Math.max(before, h)); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, onDockHeight]);
  const [phoneToolsHeight, setPhoneToolsHeight] = useState(150);
  // Larger reading text and optional Undo/status rows must never cover a thought's task count.
  // Reserve the actual dock height; widths and graph positions remain display-only geometry.
  useLayoutEffect(() => {
    const el = phoneToolsRef.current;
    if (!compact || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setPhoneToolsHeight(Math.ceil(el.getBoundingClientRect().height) + 14));
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, hasComposition]);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState<{ ids: string[]; base: Thought[]; dx: number; dy: number } | null>(null);
  const [size, setSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [panning, setPanning] = useState(false);
  // #509 AC-1: holding Space while the canvas itself (or nothing) has focus pans like the hand tool.
  // Space on a focused thought or control keeps its own meaning (select, press), so it is never captured there.
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  useEffect(() => {
    const down = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (event.key !== ' ' || !(target instanceof HTMLElement) || (target !== canvasRef.current && target !== document.body)) return;
      event.preventDefault();
      if (!spaceRef.current) { spaceRef.current = true; setSpaceHeld(true); }
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.key === ' ' && spaceRef.current) { spaceRef.current = false; setSpaceHeld(false); }
    };
    const release = () => { spaceRef.current = false; setSpaceHeld(false); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  const panMode = props.hand || spaceHeld;
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
  // The thoughts' layout follows the map's own width, not the window (#151 AC-1): a map narrower than NARROW_MAP (a phone,
  // or a desktop map beside a docked panel) shows the two columns; a wider one, the plane. The controls stay the device's:
  // `compact` (a phone window) chooses the phone's sheet and tools, never the width of the map. The wrapper's width is read
  // (not the canvas's client width), so a scrollbar that comes or goes with the layout cannot flip it back.
  const [mapWidth, setMapWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setMapWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setMapWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = compact || (mapWidth > 0 && mapWidth <= NARROW_MAP);
  // Each projection keeps its own zoom: the two columns already fit at full size (#151).
  const mode: Mode = columns ? 'compact' : 'plane';
  const [zooms, setZooms] = useState<Record<Mode, number>>({ plane: 1, compact: 1 });
  const zoom = zooms[mode];
  const modeRef = useRef<Mode>(mode);
  const setZoom = useCallback((next: number | ((z: number) => number)) => setZooms((all) => {
    const key = modeRef.current;
    return { ...all, [key]: typeof next === 'function' ? next(all[key]) : next };
  }), []);
  const [, remeasure] = useState(0);
  // S15: on a phone nothing is connected or arranged; people who can write may still add and edit text.
  // In the two columns (a phone, or a narrow map) thoughts keep their saved places: nothing is arranged by dragging.
  const arrange = canWrite && !columns;
  const observer = useRef<ResizeObserver | null>(null);
  const events = useRef<NodeEvents>(IDLE_EVENTS);
  // One ref callback for every node. An inline callback is a new function on every render, so
  // React detached and re-attached every node's ref each time: with 500 thoughts, every live
  // preview unobserved and re-observed 500 elements, and the ResizeObserver then re-measured all
  // of them (#228 Gate 4). The node's own data-id names it.
  const nodeRef = useCallback((el: HTMLButtonElement | null) => {
    const id = el?.dataset.id;
    if (!el || !id) return undefined;
    nodes.current.set(id, el); observer.current?.observe(el);
    return () => { if (nodes.current.get(id) === el) nodes.current.delete(id); observer.current?.unobserve(el); };
  }, []);
  useEffect(() => {
    if (!props.liveEnabled || props.ownGesture || !drag.current?.started || drag.current.kind === 'pan') return;
    props.onGestureCancel(); drag.current = null; setOffset(null); setSize(null);
  }, [props.liveEnabled, props.ownGesture, props.onGestureCancel]);

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

  // Lookups by id: a 200-thought drag of a 500-thought map searched the moved ids for every thought
  // on every movement frame (#228 Gate 4).
  const movingIds = offset?.ids, movingBase = offset?.base;
  const moving = useMemo(() => new Map((movingIds ?? []).map((id) => [id, movingBase?.find((thought) => thought.id === id)] as const)), [movingIds, movingBase]);
  const shown = useMemo(() => sketch.thoughts.map((t): Thought => {
    let next = t;
    // The live map moves from the positions at the gesture's start; the ordinary map, as before #228, from the current ones.
    if (offset && moving.has(t.id)) {
      if (props.liveEnabled) { const base = moving.get(t.id) ?? t; next = { ...next, x: bounded(base.x + offset.dx), y: bounded(base.y + offset.dy) }; }
      else next = { ...next, x: bounded(t.x + offset.dx), y: bounded(t.y + offset.dy) };
    }
    if (size?.id === t.id) next = { ...next, width: size.w, height: size.h };
    return next;
  }), [sketch.thoughts, offset, moving, size, props.liveEnabled]);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCanvasWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Keep the expanded, named actions in the visible canvas at any selection/zoom.
  // This is presentation geometry only; neither the saved thoughts nor camera are moved.
  useLayoutEffect(() => {
    const bar = selectionBarRef.current;
    const canvas = canvasRef.current;
    if (!bar || !canvas || compact) return;
    const placeBar = () => {
      bar.style.maxWidth = `${Math.max(0, canvas.clientWidth - 16)}px`;
      bar.style.marginLeft = '0px';
      const { above } = bar.dataset;
      const view = canvas.getBoundingClientRect();
      const bounds = bar.getBoundingClientRect();
      let dx = Math.max(view.left + 8 - bounds.left, Math.min(0, view.right - 8 - bounds.right));
      // Above the thought, clear of the floating header and notices where there is room beside them:
      // the actions move right past them. They stay above the thought either way, so they never
      // cover its connection labels (#481).
      const floating = [...(wrapRef.current?.parentElement?.querySelectorAll<HTMLElement>('.sk-over > *') ?? [])].map((el) => el.getBoundingClientRect());
      const hit = (left: number) => floating.find((r) => r.width && r.bottom > bounds.top && r.top < bounds.bottom && r.right > left && r.left < left + bounds.width);
      const blocked = above ? hit(bounds.left + dx) : undefined;
      if (blocked) {
        const right = blocked.right + 8 - bounds.left;
        if (bounds.left + right + bounds.width <= view.right - 8 && !hit(bounds.left + right)) dx = right;
      }
      bar.style.marginLeft = `${dx / zoom}px`;
    };
    placeBar();
    const observer = new ResizeObserver(placeBar);
    observer.observe(bar);
    observer.observe(canvas);
    canvas.addEventListener('scroll', placeBar, { passive: true });
    return () => { observer.disconnect(); canvas.removeEventListener('scroll', placeBar); };
  });
  const projection = columns && canvasWidth && shown.length ? project(shown, heights, canvasWidth, null) : null;
  // Nothing is drawn until the widths are known, so thoughts never slide in from the other layout.
  const measuring = (columns && !canvasWidth) || (!compact && !mapWidth);
  const rects = projection ? projection.rects : new Map<string, Rect>(shown.map((t) => [t.id, rectOf(t, heights)]));
  const scaleX = projection?.scaleX ?? 1;
  // Moving every top-row thought changes the preview's minY. Deriving the plane origin
  // from that minY moved every untouched thought too, invalidating its memoized props.
  // Keep signed native bounds for the plane; phone projection, live rects, sizes and Fit
  // still use the actual displayed graph. A thought being dragged past the edge does not move
  // the origin under the pointer; the plane grows when the move lands (#509).
  const originPoints = columns ? [...rects.values()] : props.liveEnabled ? props.confirmedThoughts ?? sketch.thoughts : sketch.thoughts;
  // #509: the plane reaches a margin beyond the thoughts in every direction, so the view pans past
  // the first thought up or left as well. The phone's two columns keep their own edges.
  const margin = columns ? 0 : PLANE_MARGIN;
  const origin = { x: Math.min(0, ...originPoints.map((r) => r.x - PAD)) - margin, y: Math.min(0, ...originPoints.map((r) => r.y - (columns ? PAD : 128))) - margin };
  let width = 0;
  let height = 0;
  for (const r of rects.values()) { width = Math.max(width, r.x + r.w - origin.x); height = Math.max(height, r.y + r.h - origin.y); }
  // Room to keep sketching beyond the last thought.
  width += columns ? 0 : PLANE_MARGIN;
  height += columns ? 160 : PLANE_MARGIN;
  const place = (r: Rect) => ({ x: r.x - origin.x, y: r.y - origin.y });
  // When the origin moves, every thought's place changes with it while the view compensates: that
  // change must not animate, or the whole map would slide across the screen (#509).
  const [lastOrigin, setLastOrigin] = useState(origin);
  const [reframing, setReframing] = useState(false);
  if (lastOrigin.x !== origin.x || lastOrigin.y !== origin.y) { setLastOrigin(origin); setReframing(true); }
  useEffect(() => {
    if (!reframing) return;
    const frame = requestAnimationFrame(() => setReframing(false));
    return () => cancelAnimationFrame(frame);
  }, [reframing]);
  const last = selection.length ? rects.get(selection[selection.length - 1]!) : undefined;
  const lastThought = selection.length ? shown.find((t) => t.id === selection[selection.length - 1]) : undefined;
  const byId = new Map(shown.map((t) => [t.id, t]));

  // Use visible card/control rectangles, including zoom and the person's scroll.
  // Only the local editor moves: thoughts, the draft's saved position and camera stay put.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const editor = compositionRef.current;
    const canvas = canvasRef.current;
    if (!hasComposition || !wrap || !editor || !canvas) return;
    const placeEditor = () => {
      if (compact) { setCompositionHeight(Math.ceil(editor.getBoundingClientRect().height) + 20); return; }
      const pane = wrap.getBoundingClientRect();
      const box = editor.getBoundingClientRect();
      const gap = 12;
      const maxX = Math.max(14, pane.width - box.width - 14);
      const maxY = Math.max(14, pane.height - box.height - 14);
      const obstacles = [...wrap.parentElement!.querySelectorAll<HTMLElement>('.sk-node, .sk-work-slot, .sk-actions, .sk-ghost--draft, .sk-wires .sk-wire, .sk-head, .sk-dock__row, .sk-dock .sk-line, .sk-dock > .sk-hint, .sk-origin, .sk-copies')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left - pane.left, top: r.top - pane.top, right: r.right - pane.left, bottom: r.bottom - pane.top,
            source: !!props.draft?.parentId && el.dataset.id === props.draft.parentId };
        }).filter((r) => r.right > 0 && r.bottom > 0 && r.left < pane.width && r.top < pane.height);
      const preview = wrap.querySelector('.sk-ghost--draft')?.getBoundingClientRect();
      const preferred = preview ? { left: preview.right - pane.left + gap, top: preview.top - pane.top } : { left: maxX, top: 14 };
      const xs = [14, maxX, preferred.left, ...obstacles.flatMap((r) => [r.right + gap, r.left - box.width - gap])];
      const ys = [14, maxY, preferred.top, ...obstacles.flatMap((r) => [r.bottom + gap, r.top - box.height - gap])];
      let best = { left: 14, top: 14, score: Infinity };
      for (const x of xs) for (const y of ys) {
        const left = clamp(x, 14, maxX);
        const top = clamp(y, 14, maxY);
        const overlap = obstacles.reduce((area, r) => area + Math.max(0, Math.min(left + box.width, r.right + gap) - Math.max(left, r.left - gap))
          * Math.max(0, Math.min(top + box.height, r.bottom + gap) - Math.max(top, r.top - gap)) * (r.source ? 100 : 1), 0);
        const score = overlap * 10000 + Math.hypot(left - preferred.left, top - preferred.top);
        if (score < best.score) best = { left, top, score };
      }
      setCompositionPosition((old) => old && old.left === best.left && old.top === best.top ? old : { left: best.left, top: best.top });
    };
    placeEditor();
    const ro = new ResizeObserver(placeEditor);
    ro.observe(editor); ro.observe(wrap); ro.observe(canvas);
    canvas.addEventListener('scroll', placeEditor, { passive: true });
    return () => { ro.disconnect(); canvas.removeEventListener('scroll', placeEditor); };
  }, [hasComposition, compact, zoom, selection, props.draft?.parentId, shown, phoneToolsHeight]);

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

  // #509: the plane has no fixed edge, so its origin follows the outermost thoughts. When it moves
  // (a thought landed beyond the edge) the view moves with it, so nothing on screen jumps. A zoom
  // keeps the plane point under its anchor (the pointer, the pinch or the view's centre) in place.
  const shownView = useRef<{ mode: Mode; zoom: number; x: number; y: number } | null>(null);
  const zoomAnchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  const keepAnchor = useCallback((el: HTMLElement, anchor: { cx: number; cy: number; px: number; py: number }, o: { x: number; y: number }, z: number) => {
    const box = zoomedRef.current?.getBoundingClientRect();
    if (!box) return;
    el.scrollLeft += box.left + (anchor.px - o.x) * z - anchor.cx;
    el.scrollTop += box.top + (anchor.py - o.y) * z - anchor.cy;
  }, []);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const before = shownView.current;
    shownView.current = { mode, zoom, x: origin.x, y: origin.y };
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!el || !before || before.mode !== mode || mode !== 'plane') return;
    if (anchor && before.zoom !== zoom) keepAnchor(el, anchor, origin, zoom);
    else if (before.zoom === zoom && (before.x !== origin.x || before.y !== origin.y)) {
      el.scrollLeft += (before.x - origin.x) * zoom;
      el.scrollTop += (before.y - origin.y) * zoom;
    } else return;
    record(el);
  });
  /** Zoom to `next`, keeping the plane point at client `cx`,`cy` (default: the middle of the visible map) still. */
  const zoomAt = useCallback((next: number, cx?: number, cy?: number) => {
    const el = canvasRef.current;
    const box = zoomedRef.current?.getBoundingClientRect();
    const { origin: o, zoom: z } = geometry.current;
    const target = clamp(Math.round(next * 1000) / 1000, ZOOMS[0]!, ZOOMS[ZOOMS.length - 1]!);
    if (el && box && modeRef.current === 'plane' && target !== z) {
      const view = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const top = view.top + (parseFloat(style.paddingTop) || 0);
      const bottom = view.top + el.clientHeight - (parseFloat(style.paddingBottom) || 0);
      const x = cx ?? view.left + el.clientWidth / 2;
      const y = cy ?? (top + bottom) / 2;
      zoomAnchor.current = { cx: x, cy: y, px: (x - box.left) / z + o.x, py: (y - box.top) / z + o.y };
    }
    setZoom(target);
  }, [setZoom]);

  // Fit: show the whole graph when it fits at a readable size, otherwise start at its top left. Opening uses the
  // working floor (OPEN_MIN); the Fit button, an explicit overview, may go down to FIT_MIN.
  const fit = useCallback((floor = FIT_MIN) => {
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
    const top = parseFloat(style.paddingTop) || 0;
    const room = canvas.clientHeight - top - (parseFloat(style.paddingBottom) || 0);
    let scale = Math.min(1, canvas.clientWidth / (maxX - minX), room / (maxY - minY));
    // #509: the fitted graph starts at the top left and stays clear of the minimap and zoom in the
    // bottom-right corner, beside them or above them, whichever keeps it larger.
    const view = canvas.getBoundingClientRect();
    const corner = wrapRef.current?.querySelector('.sk-corner')?.getBoundingClientRect();
    if (corner?.width) scale = Math.min(scale, Math.max((corner.left - view.left - 8) / (maxX - minX), (corner.top - view.top - top - 8) / (maxY - minY)));
    const z = Math.max(coarseRef.current ? Math.max(FIT_MIN_COARSE, floor) : floor, Math.floor(scale * 100) / 100);
    setZoom(z);
    cameras.current.plane = { left: Math.max(0, (minX - o.x) * z), top: Math.max(0, (minY - o.y) * z) };
    requestAnimationFrame(apply);
  }, [apply, setZoom]);
  const fitted = useRef(false);
  const hasThoughts = sketch.thoughts.length > 0;
  useEffect(() => {
    if (fitted.current || !hasThoughts) return;
    fitted.current = true;
    fit(OPEN_MIN);
  }, [hasThoughts, fit]);
  const highlighted = (id: string) => selection.includes(id) || connectFrom === id;

  // The first-run hint floats over the canvas above the dock; where a thought lies under it (a card at the bottom of the
  // view, as at 1440×900 opening at 90%), it steps aside, so it never sits on a card's text. Checked after a scroll,
  // a resize or a change of the thoughts, a frame later. The hint sits inside the status line (`.sk-dock > .sk-line`,
  // #757); the drag hint, a direct child of the dock, is feedback for a gesture in progress and stays. The listeners are set up
  // once per layout; a change of the thoughts or the zoom only asks for the check, so a peer's live preview (a new `rects` on
  // every frame) never observes the canvas and the dock again (#228 Gate 4).
  const hintCheck = useRef<() => void>(() => undefined);
  useEffect(() => {
    const canvas = canvasRef.current;
    const dock = dockRef.current;
    if (!canvas || !dock || compact) return undefined;
    let frame = 0;
    const check = () => {
      frame = 0;
      const hint = dock.querySelector<HTMLElement>(':scope > .sk-line > .sk-hint');
      if (!hint) return;
      const h = hint.getBoundingClientRect();
      const over = [...canvas.querySelectorAll<HTMLElement>('.sk-node')].some((node) => {
        const r = node.getBoundingClientRect();
        return r.right > h.left && r.left < h.right && r.bottom > h.top && r.top < h.bottom;
      });
      if (over) hint.setAttribute('data-over-card', ''); else hint.removeAttribute('data-over-card');
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(check); };
    hintCheck.current = later;
    later();
    canvas.addEventListener('scroll', later, { passive: true });
    const observer = new ResizeObserver(later);
    observer.observe(canvas);
    observer.observe(dock);
    return () => { hintCheck.current = () => undefined; if (frame) cancelAnimationFrame(frame); canvas.removeEventListener('scroll', later); observer.disconnect(); };
  }, [compact]);
  useEffect(() => { hintCheck.current(); }, [rects, zoom]);
  // #509 AC-3: Ctrl/⌘ + wheel (a trackpad pinch arrives the same way) zooms smoothly around the
  // pointer; a plain wheel or two-finger scroll pans natively. React's wheel listener is passive, and
  // the zoom must be cancellable to replace the browser's page zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const wheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      zoomAt(geometry.current.zoom * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomAt]);
  // Two fingers on a touch screen pinch-zoom around their midpoint and move the view with it.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || compact) return;
    let pinch: { distance: number; zoom: number; px: number; py: number } | null = null;
    const points = (event: TouchEvent) => {
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      return { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) { pinch = null; return; }
      const box = zoomedRef.current?.getBoundingClientRect();
      if (!box) return;
      const { distance, cx, cy } = points(event);
      const { origin: o, zoom: z } = geometry.current;
      pinch = { distance: Math.max(1, distance), zoom: z, px: (cx - box.left) / z + o.x, py: (cy - box.top) / z + o.y };
    };
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const { distance, cx, cy } = points(event);
      const next = clamp(Math.round(pinch.zoom * (distance / pinch.distance) * 1000) / 1000, ZOOMS[0]!, ZOOMS[ZOOMS.length - 1]!);
      const anchor = { cx, cy, px: pinch.px, py: pinch.py };
      if (next === geometry.current.zoom) { keepAnchor(el, anchor, geometry.current.origin, next); return; }
      zoomAnchor.current = anchor;
      setZoom(next);
    };
    const end = (event: TouchEvent) => { if (event.touches.length < 2) pinch = null; };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [compact, keepAnchor, setZoom]);

  // #509 AC-6: with the map itself focused, arrows move the view (Shift further); thoughts keep their own arrows.
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 240 : 48;
    const [dx, dy] = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key] ?? [0, 0];
    if (!dx && !dy) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += dx;
    event.currentTarget.scrollTop += dy;
  };

  const begin = (event: ReactPointerEvent, next: Omit<Drag, 'pointerId' | 'sx' | 'sy' | 'moved' | 'started' | 'base' | 'resizeHeight'>) => {
    const resizing = next.kind === 'resize' ? byId.get(next.id!) : undefined;
    const resizeHeight = resizing ? Math.max(resizing.height, heights.get(resizing.id) ?? 0) : undefined;
    drag.current = { ...next, resizeHeight, base: sketch.thoughts.filter((thought) => next.ids.includes(thought.id)).map((thought) => ({ ...thought })), pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, moved: false, started: false };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    // With the hand tool or Space held, a thought is part of the plane: the plane pans.
    if (panMode || event.button !== 0 || editing?.id === id || !arrange) return;
    // On touch, only a selected thought drags; elsewhere a finger scrolls the map.
    if (event.pointerType !== 'mouse' && !selection.includes(id)) return;
    begin(event, { kind: 'move', id, ids: selection.includes(id) ? selection : [id] });
  };

  const onDotPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (panMode) return;
    event.stopPropagation();
    if (event.button !== 0 || !arrange) return;
    begin(event, { kind: 'link', id, ids: [id] });
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLSpanElement>, id: string) => {
    event.stopPropagation();
    const thought = byId.get(id);
    if (event.button !== 0 || !thought) return;
    begin(event, { kind: 'resize', id: thought.id, ids: [thought.id] });
  };

  const onPlanePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || target.closest('input, textarea, [contenteditable="true"]')) return;
    // Empty space pans with a mouse; the hand tool and Space pan from anywhere, with any pointer.
    const empty = target === event.currentTarget || target.classList.contains('sk-plane');
    if (!panMode && (!empty || event.pointerType !== 'mouse')) return;
    const canvas = canvasRef.current!;
    begin(event, { kind: 'pan', ids: [], scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse' && !compact) {
      const at = zoomedRef.current!.getBoundingClientRect();
      props.onPointer({ x: bounded(Math.round((event.clientX - at.left) / zoom + origin.x)), y: bounded(Math.round((event.clientY - at.top) / zoom + origin.y)) });
    }
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = (event.clientX - d.sx) / zoom;
    const dy = (event.clientY - d.sy) / zoom;
    if (!d.moved && Math.hypot(event.clientX - d.sx, event.clientY - d.sy) < 4) return;
    if (!d.moved) {
      // Keep the same trusted-input threshold as local movement. A Shift-click
      // changes selection without allocating a lease or racing a late cancellation
      // against the next selected group's actual drag.
      if (d.kind !== 'pan') {
        if (!props.onGestureStart(d.ids)) { drag.current = null; return; }
        d.started = true;
      }
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
      setWire({ from: d.id!, x: bounded(Math.round((event.clientX - box.left) / zoom + origin.x)), y: bounded(Math.round((event.clientY - box.top) / zoom + origin.y)), over: over && over !== d.id ? over : null });
    } else if (d.kind === 'move') {
      // Offsets are in stored plane units; the phone projection compresses x.
      setOffset({ ids: d.ids, base: d.base, dx: Math.round(dx * scaleX), dy: Math.round(dy) });
      props.onGesturePreview(d.base.map((thought) => ({ id: thought.id, x: bounded(Math.round(thought.x + dx * scaleX)), y: bounded(Math.round(thought.y + dy)) })));
    } else {
      const t = byId.get(d.id!) ?? sketch.thoughts.find((x) => x.id === d.id);
      const base = (props.liveEnabled ? d.base.find((x) => x.id === d.id) : sketch.thoughts.find((x) => x.id === d.id)) ?? t!;
      const width = clamp(Math.round(base.width + dx), SKETCH_LIMITS.minWidth, SKETCH_LIMITS.maxWidth);
      const height = clamp(Math.round((d.resizeHeight ?? base.height) + dy), SKETCH_LIMITS.minHeight, SKETCH_LIMITS.maxHeight);
      setSize({ id: d.id!, w: width, h: height });
      props.onGesturePreview([{ id: base.id, x: base.x, y: base.y, width, height }]);
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
      else if (!hitsDot(event, d.id!)) props.onAddAt(d.id!, end.x, bounded(end.y - Math.round(DEFAULT_THOUGHT_SIZE.height / 2)));
      return;
    }
    if (d.kind === 'move' && offset) {
      props.onMove(d.ids.flatMap((id) => {
        if (!props.liveEnabled) {
          const t = sketch.thoughts.find((x) => x.id === id);
          return t ? [{ id, x: bounded(t.x + offset.dx), y: bounded(t.y + offset.dy) }] : [];
        }
        const t = d.base.find((x) => x.id === id);
        return t ? [{ id, x: bounded(t.x + offset.dx), y: bounded(t.y + offset.dy) }] : [];
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
    if (drag.current?.started) props.onGestureCancel();
    drag.current = null;
    setWire(null);
    setPanning(false);
    setOffset(null);
    setSize(null);
  };

  const onNodeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const thought = byId.get(id);
    if (!thought) return;
    const { key } = event;
    if (key === 'Enter' || key === 'F2') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else if (canWrite) props.onEdit(thought.id); return; }
    if (key === ' ') { event.preventDefault(); if (connectFrom) props.onPick(thought.id, false); else props.onToggle(thought.id); return; }
    if (key === 'Escape') { if (props.liveEnabled && drag.current && drag.current.kind !== 'pan') { onPointerCancel(); event.preventDefault(); event.stopPropagation(); } else if (props.onEscape()) { event.preventDefault(); event.stopPropagation(); } return; }
    if (!canWrite) return;
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
      return t ? [{ id, x: bounded(t.x + dx), y: bounded(t.y + dy) }] : [];
    }), 'keyboard');
    requestAnimationFrame(() => nodes.current.get(thought.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };

  // The memoized thoughts call the handlers of the latest render (#228 Gate 4).
  useLayoutEffect(() => {
    events.current = { pointerDown: onNodePointerDown, resizePointerDown: onResizePointerDown, keyDown: onNodeKeyDown,
      click: (event, id) => { if (suppressClick.current) return; props.onPick(id, event.shiftKey || event.metaKey || event.ctrlKey); },
      doubleClick: (id) => { if (canWrite && !connectFrom) props.onEdit(id); },
      openTask: (id) => props.onOpenTask(id), pointerEnter: (event, id) => { if (event.pointerType === 'mouse') setHover(id); },
      // Moving between a thought and its own dots keeps it hovered, so its dots stay in place under the pointer.
      pointerLeave: (event, id) => { if (!ownPart(event.relatedTarget, id)) setHover((current) => current === id ? null : current); },
      dotPointerDown: (event, id) => onDotPointerDown(event, id),
      dotClick: (id) => { if (!suppressClick.current) props.onConnectFrom(id); } };
  });

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
  const selectionBar = (style?: CSSProperties, above?: boolean) => {
    if (!plus || !last || !lastThought) return null;
    const single = selection.length === 1;
    const label = quote(lastThought.text);
    const close = (run: () => void) => () => { setMore(false); run(); };
      return (
        <div ref={selectionBarRef} className="sk-actions" role="toolbar" aria-label="Selection actions" style={style} data-above={above ? 'true' : undefined}>
          {single ? <button type="button" className="sk-edit-btn" aria-label={`Edit ${label}`} onClick={() => props.onEdit(lastThought.id)}>Edit</button> : null}
          {single && !compact ? <button type="button" className="sk-edit-btn" aria-label="Connect" aria-pressed={connectFrom === lastThought.id} onClick={() => props.onConnectFrom(lastThought.id)}>Connect</button> : null}
          {single && !compact ? <button type="button" className="sk-edit-btn" onClick={() => props.onConnections(lastThought.id)}>Connections</button> : null}
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
  // #509 AC-3: − level + | Fit, in their own group at the bottom right of the map.
  const zoomControls = (
    <div className="sk-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" data-tip="Zoom out" disabled={zoom <= ZOOMS[0]!} onClick={() => zoomAt(zoomOut(zoom))}><Icon name="minus" size={14} /></button>
      <button type="button" className="sk-zoom__level" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`} onClick={() => zoomAt(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in" data-tip="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => zoomAt(zoomIn(zoom))}><Icon name="plus" size={14} /></button>
      <span className="sk-div" aria-hidden="true" />
      <button type="button" className="sk-zoom__fit" aria-label="Fit the sketch to the view" onClick={() => fit()}>Fit</button>
    </div>
  );

  const thoughtNodes: ReactNode[] = [];
  if (!measuring) {
    const chosen = new Set(selection);
    for (const thought of shown) {
      const r = rects.get(thought.id)!;
      const p = place(r);
      const selected = chosen.has(thought.id);
      const dragging = moving.has(thought.id);
      // UI116-4: a count of the linked tasks, never their titles or results, under the text.
      thoughtNodes.push(
        <Fragment key={thought.id}>
        <ThoughtNode thought={thought} x={p.x} y={p.y} w={r.w} h={r.h} selected={selected}
          dragging={dragging} editing={editing?.id === thought.id}
          resizable={selected && selection.length === 1 && arrange && !coarse && !editing}
          meId={meId} helpId={helpId} projectId={projectId}
          linked={projectId ? tasks.get(thought.id) : undefined}
          mover={props.movers.get(thought.id)} live={props.livePreviews.get(thought.id)} nodeRef={nodeRef} events={events} />
        {arrange && !editing && !measuring && !dragging && (selected || connectFrom === thought.id || hover === thought.id || wire?.from === thought.id) ? (
          <ThoughtDots id={thought.id} text={thought.text} x={p.x} y={p.y} w={r.w} h={r.h} zoom={zoom} selected={selected}
            on={selected || connectFrom === thought.id || hover === thought.id} events={events} />
        ) : null}
        </Fragment>
      );
    }
  }

  return (
    <div ref={wrapRef} className={`sk-canvas-wrap sk-canvas-wrap--controls${hasComposition ? ' has-composition' : ''}`} style={(compact ? { '--sk-phone-tools-height': `${hasComposition ? compositionHeight : phoneToolsHeight}px` } : { '--sk-dock-h': `${dockHeight}px` }) as unknown as CSSProperties}>
    {props.presenceStore ? <MapPeople source={props.presenceStore} /> : null}
    <div data-layout={columns ? 'columns' : 'plane'} className={`sk-canvas${panning ? ' is-panning' : ''}${panMode ? ' is-hand' : ''}${connectFrom ? ' is-connecting' : ''}${wire ? ' is-wiring' : ''}`} ref={canvasRef} role="group" tabIndex={0}
      data-live-own-gesture={props.ownGesture?.id} data-live-own-sequence={props.ownGesture?.sequence} data-live-generation={props.ownGesture?.generation}
      aria-label={`Sketch: ${sketch.title}`} aria-describedby={helpId} onKeyDown={onCanvasKeyDown}>
      <div className="sk-zoomed" ref={zoomedRef} data-origin-x={origin.x} data-origin-y={origin.y} style={{ width: width * zoom, height: height * zoom }}
        onPointerDown={onPlanePointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={() => props.onPointer(null)}>
        <div className={`sk-plane${reframing ? ' is-reframing' : ''}`} style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
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
          {canWrite && !compact ? <svg className="sk-edge-hits" width={width} height={height} aria-hidden="true">
            {sketch.links.map((link) => {
              const a = rects.get(link.fromId);
              const b = rects.get(link.toId);
              if (!a || !b) return null;
              return <path key={link.id} data-link-id={link.id} d={linkPath({ ...a, ...place(a) }, { ...b, ...place(b) }).d}
                onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
                  event.stopPropagation();
                  nodes.current.get(link.fromId)?.focus({ preventScroll: true });
                  props.onLabel(link.id);
                }} />;
            })}
          </svg> : null}
          <svg className="sk-wires" width={width} height={height} aria-hidden="true">
            {wireFrom && wire ? <path className="sk-wire" d={linkPath({ ...wireFrom, ...place(wireFrom) }, wire.over && rects.get(wire.over) ? { ...rects.get(wire.over)!, ...place(rects.get(wire.over)!) } : { ...ghost(wire.x, wire.y), x: wire.x - origin.x, y: wire.y - origin.y }).d} /> : null}
            {draftFrom && props.draft ? <path className="sk-wire" d={linkPath({ ...draftFrom, ...place(draftFrom) }, { ...ghost(props.draft.x, props.draft.y), x: props.draft.x - origin.x, y: props.draft.y - origin.y }).d} /> : null}
          </svg>
          <div className="sk-labels">
            {sketch.links.map((link) => {
              const a = rects.get(link.fromId);
              const b = rects.get(link.toId);
              if (!a || !b) return null;
              const editable = canWrite && !compact;
              if (!link.label && !(editable && (selection.includes(link.fromId) || selection.includes(link.toId)))) return null;
              const { mid } = linkPath({ ...a, ...place(a) }, { ...b, ...place(b) });
              const on = highlighted(link.fromId) || highlighted(link.toId);
              const style = { transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`, minHeight: editable ? (coarse ? 44 : 28) / zoom : undefined, minWidth: editable && coarse ? 44 / zoom : undefined };
              return editable ? <button key={link.id} type="button" className={`sk-el sk-el--edit${on ? ' is-on' : ''}`} style={style}
                data-link-id={link.id} title={link.label ?? 'Add label'}
                aria-label={`${link.label ? 'Edit' : 'Add'} label between ${byId.get(link.fromId)?.text} and ${byId.get(link.toId)?.text}`}
                onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
                  event.stopPropagation();
                  // The label button can disappear when cleared; restore focus to its stable thought.
                  nodes.current.get(link.fromId)?.focus({ preventScroll: true });
                  props.onLabel(link.id);
                }}>
                {link.label ?? '+ Label'}
              </button> : <span key={link.id} className={`sk-el${on ? ' is-on' : ''}`} style={style}>{link.label}</span>;
            })}
          </div>
          {thoughtNodes}
          {props.presenceStore ? <MapCursors source={props.presenceStore} origin={origin} zoom={zoom} rects={rects} plane={{ x: origin.x, y: origin.y, w: width, h: height }} /> : null}
          {plus && last && lastThought ? (!compact ? (hasComposition ? null : (() => {
            // Controls keep their on-screen size at every zoom (touch targets stay 44px).
            const x = plus.x + last.w / 2;
            const keep = `scale(${1 / zoom})`;
            const at = plus.y < 56 ? `translate(${x}px, ${plus.y + last.h + 8}px) ${keep} translateX(-50%)` : `translate(${x}px, ${plus.y - 8}px) ${keep} translate(-50%, -100%)`;
            return selectionBar({ transform: at }, plus.y >= 56);
          })()) : null) : linkAnchor && last ? (() => {
            // People who can only look still open a selected link.
            const at = place(last);
            return <div className="sk-actions" style={{ transform: `translate(${at.x + last.w / 2}px, ${at.y + last.h + 6}px) scale(${1 / zoom}) translateX(-50%)` }}>{linkAnchor}</div>;
          })() : null}
          {wire && !wire.over && wireFrom ? (
            <div className="sk-ghost" aria-hidden="true" style={{ transform: `translate(${wire.x - origin.x}px, ${wire.y - origin.y}px)`, width: DEFAULT_THOUGHT_SIZE.width, height: DEFAULT_THOUGHT_SIZE.height }}>New thought</div>
          ) : null}
          {props.draft && !columns ? (
            <div className="sk-ghost sk-ghost--draft" aria-hidden="true" style={{ transform: `translate(${props.draft.x - origin.x}px, ${props.draft.y - origin.y}px)`, width: DEFAULT_THOUGHT_SIZE.width, height: DEFAULT_THOUGHT_SIZE.height }}>{props.draft.label}</div>
          ) : null}
          {editing && editingRect && editingThought && canWrite ? (
            <ThoughtEditor key={`${editing.id}:${editing.attempt}`} className="sk-edit" initial={editing.initial} disabled={editing.saving} onChange={props.onEditText}
              style={{ transform: `translate(${place(editingRect).x + 6}px, ${place(editingRect).y + 6}px)`, width: editingRect.w - 12 }}
              onDone={props.onFinishEdit} />
          ) : null}
        </div>
      </div>
    </div>
      {!compact ? <div className="sk-corner"><Minimap canvas={canvasRef} zoom={zoom} origin={origin} rects={rects} />{zoomControls}</div> : null}
      <div className="sk-dock" ref={dockRef}>
        {!compact ? (wire ? <p className="sk-hint" aria-hidden="true">{wire.over ? 'Release to link' : 'Release to add a connected thought'}</p> : props.hint) : null}
        {props.dock ? <div className="sk-dock__row">{props.dock}</div> : null}
      </div>
      {compact ? <button type="button" className="sk-edit-btn sk-map-options" aria-haspopup="dialog" aria-expanded={phoneMenuOpen && phoneMenu === 'map'} onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true }); setPhoneMenu('map'); setPhoneMenuOpen(true);
      }}><Icon name="more" size={16} />Map options</button> : null}
      {hasComposition ? <div ref={compositionRef} className="sk-composition" style={compact ? undefined : { left: compositionPosition?.left ?? 14, top: compositionPosition?.top ?? 14, visibility: compositionPosition ? undefined : 'hidden' }}>
        {props.draftEditor?.(compact || compositionPosition !== null)}
        {compact && canWrite && props.bar.canUndo ? <button type="button" className="sk-undo" aria-label="Undo" onClick={props.bar.onUndo}>
          <Icon name="undo" size={16} />Undo last saved change
        </button> : null}
        {compact ? props.hint : null}
      </div> : null}
      {compact && !hasComposition ? (
        <div className="sk-phone" ref={phoneToolsRef}>
          {props.hint}
          {canWrite ? <>
          <div className="sk-phone__secondary">
            {plus ? <button type="button" className="sk-edit-btn" aria-haspopup="dialog" aria-expanded={phoneMenuOpen && phoneMenu === 'thought'} onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true }); setPhoneMenu('thought'); setPhoneMenuOpen(true);
            }}><Icon name="more" size={16} />Thought actions</button> : null}
            {props.bar.canUndo ? <button type="button" className="sk-undo" aria-label="Undo" onClick={props.bar.onUndo}><Icon name="undo" size={16} />Undo</button> : null}
          </div>
          <p className="sk-phone__note"><Icon name="monitor" size={16} />Connect and arrange on a computer</p>
          <button type="button" className="sk-fab sk-add" onClick={props.onAddThought}><Icon name="plus" size={18} />Add a thought</button>
          </> : null}
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
            {selection.length === 1 ? <button type="button" className="sk-options__action" onClick={() => phoneAction(() => props.onEdit(lastThought.id))}><Icon name="edit" size={18} />Edit thought</button> : null}
            {openLink ? <a className="sk-options__action" href={openLink.href} target="_blank" rel="noopener noreferrer"><Icon name="link" size={18} />Open link {openLink.host}</a> : null}
            {props.bar.project ? <button type="button" className="sk-options__action" aria-label="Create task from selected thoughts" aria-disabled={false} onClick={() => phoneAction(props.bar.onTask)}><Icon name="tasks" size={18} />Create task</button> : null}
            {props.bar.onCite ? <button type="button" className="sk-options__action" aria-label="Cite the selected thought in the conversation" onClick={() => phoneAction(props.bar.onCite!)}><Icon name="cite" size={18} />Cite in conversation</button> : null}
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

const MINIMAP = { w: 172, h: 112 };
const MINIMAP_PAD = 24;
type Frame = { x0: number; y0: number; k: number; dx: number; dy: number };

/**
 * The whole map at a glance (#509 AC-4): every thought and the part of the plane on screen. A click
 * or a drag on it centres the view there. Drawn in plane units, so it stays right at every zoom; the
 * frame holds the thoughts and the view together, and stays still while a drag moves the view. The
 * arrows on the focused map are its keyboard equivalent, so it is hidden from assistive technology.
 */
function Minimap({ canvas, zoom, origin, rects }: { canvas: RefObject<HTMLDivElement | null>; zoom: number; origin: { x: number; y: number }; rects: Map<string, Rect> }) {
  const [view, setView] = useState({ left: 0, top: 0, w: 0, h: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; frame: Frame } | null>(null);
  const [frozen, setFrozen] = useState<Frame | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const read = () => setView({ left: el.scrollLeft / zoom, top: el.scrollTop / zoom, w: el.clientWidth / zoom, h: el.clientHeight / zoom });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', read); ro.disconnect(); };
  }, [canvas, zoom]);
  const boxes = [...rects.values()].map((r) => ({ x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h }));
  if (!boxes.length) return null;
  const fresh = (): Frame => {
    const x0 = Math.min(view.left, ...boxes.map((b) => b.x - MINIMAP_PAD));
    const y0 = Math.min(view.top, ...boxes.map((b) => b.y - MINIMAP_PAD));
    const x1 = Math.max(view.left + view.w, ...boxes.map((b) => b.x + b.w + MINIMAP_PAD));
    const y1 = Math.max(view.top + view.h, ...boxes.map((b) => b.y + b.h + MINIMAP_PAD));
    const k = Math.min(MINIMAP.w / Math.max(1, x1 - x0), MINIMAP.h / Math.max(1, y1 - y0));
    return { x0, y0, k, dx: (MINIMAP.w - (x1 - x0) * k) / 2, dy: (MINIMAP.h - (y1 - y0) * k) / 2 };
  };
  const frame = frozen ?? fresh();
  const at = (x: number, y: number) => ({ x: frame.dx + (x - frame.x0) * frame.k, y: frame.dy + (y - frame.y0) * frame.k });
  const go = (event: ReactPointerEvent<HTMLDivElement>, f: Frame) => {
    const el = canvas.current;
    const rect = box.current?.getBoundingClientRect();
    if (!el || !rect) return;
    const px = (event.clientX - rect.left - f.dx) / f.k + f.x0;
    const py = (event.clientY - rect.top - f.dy) / f.k + f.y0;
    el.scrollTo({ left: px * zoom - el.clientWidth / 2, top: py * zoom - el.clientHeight / 2 });
  };
  const press = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, frame };
    setFrozen(frame);
    event.currentTarget.setPointerCapture(event.pointerId);
    go(event, frame);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) go(event, drag.current.frame); };
  const release = () => { drag.current = null; setFrozen(null); };
  const shown = at(view.left, view.top);
  return (
    <div ref={box} className="sk-minimap" aria-hidden="true" onPointerDown={press} onPointerMove={move} onPointerUp={release} onPointerCancel={release}>
      <svg width={MINIMAP.w} height={MINIMAP.h}>
        {boxes.map((b, i) => { const p = at(b.x, b.y); return <rect key={i} x={p.x} y={p.y} width={Math.max(3, b.w * frame.k)} height={Math.max(2, b.h * frame.k)} rx={1.5} />; })}
      </svg>
      <div className="sk-minimap__view" style={{ left: shown.x, top: shown.y, width: view.w * frame.k, height: view.h * frame.k }} />
    </div>
  );
}

interface NodeEvents {
  pointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string): void;
  resizePointerDown(event: ReactPointerEvent<HTMLSpanElement>, id: string): void;
  keyDown(event: KeyboardEvent<HTMLButtonElement>, id: string): void;
  click(event: ReactMouseEvent<HTMLButtonElement>, id: string): void;
  doubleClick(id: string): void;
  openTask(id: string): void;
  pointerEnter(event: ReactPointerEvent<HTMLButtonElement>, id: string): void;
  pointerLeave(event: ReactPointerEvent<HTMLButtonElement>, id: string): void;
  dotPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string): void;
  dotClick(id: string): void;
}
const IDLE_EVENTS: NodeEvents = { pointerDown() {}, resizePointerDown() {}, keyDown() {}, click() {}, doubleClick() {}, openTask() {}, pointerEnter() {}, pointerLeave() {}, dotPointerDown() {}, dotClick() {} };

/** Whether `target` is thought `id` itself or one of its connection dots. */
function ownPart(target: EventTarget | null, id: string) {
  const part = target instanceof Element ? target.closest<HTMLElement>('.sk-node, .sk-dot') : null;
  return !!part && (part.dataset.id === id || part.dataset.for === id);
}

/**
 * The two connection dots of one thought. A thought has them only while they can be used: when it
 * is selected, hovered, the connection source or the wire's start (the dots are invisible
 * otherwise), and not while it is being moved: 200 moved thoughts would restyle 400 dots per frame. Rendering 1,000 invisible dots for a 500-thought map, all re-rendered and restyled
 * on every movement preview, doubled the map's elements and slowed every frame of a live drag
 * on both computers (#228 Gate 4). Memoized like the thoughts, with stable handlers.
 */
const ThoughtDots = memo(function ThoughtDots({ id, text, x, y, w, h, zoom, selected, on, events }: {
  id: string; text: string; x: number; y: number; w: number; h: number; zoom: number; selected: boolean; on: boolean;
  events: { readonly current: NodeEvents };
}) {
  return <>{(['right', 'left'] as const).map((side) => (
    <button key={side} type="button" tabIndex={selected && side === 'right' ? 0 : -1} data-for={id} data-side={side}
      aria-label={`Connect from ${quote(text)}: drag to another thought, or press Enter and choose one`} aria-hidden={side === 'left' ? true : undefined}
      onPointerEnter={(event) => events.current.pointerEnter(event, id)} onPointerLeave={(event) => events.current.pointerLeave(event, id)}
      className={`sk-dot${on ? ' is-on' : ''}`}
      style={{ transform: `translate(${x + (side === 'right' ? w : 0)}px, ${y + h / 2}px) scale(${1 / zoom}) translate(-50%, -50%)` }}
      onPointerDown={(event) => events.current.dotPointerDown(event, id)}
      onClick={() => events.current.dotClick(id)} />
  ))}</>;
});

interface ThoughtNodeProps {
  thought: Thought;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  dragging: boolean;
  editing: boolean;
  resizable: boolean;
  meId: string;
  helpId: string;
  projectId: string | null;
  linked: ThoughtTasksEntry | undefined;
  mover: string | undefined;
  live: { generation: string; gestureId: string; leaseId: string; sequence: number } | undefined;
  nodeRef(el: HTMLButtonElement | null): (() => void) | undefined;
  events: { readonly current: NodeEvents };
}

/**
 * One thought on the plane. Its props are plain values and stable references, so a live preview
 * re-renders only the thoughts it moves: re-rendering all 500 thoughts of a map for every preview
 * kept a peer's main thread busy and delayed the next preview's receipt (#228 Gate 4).
 */
const ThoughtNode = memo(function ThoughtNode({ thought, x, y, w, h, selected, dragging, editing, resizable, meId, helpId, projectId, linked, mover, live, nodeRef, events }: ThoughtNodeProps) {
  const id = thought.id;
  // Geometry and sequence still render each preview. Host callbacks keep their identity,
  // while the committed root events resolve this ID against its latest shown thought.
  const handlers = useMemo(() => ({
    pointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => events.current.pointerDown(event, id),
    pointerEnter: (event: ReactPointerEvent<HTMLButtonElement>) => events.current.pointerEnter(event, id),
    pointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => events.current.pointerLeave(event, id),
    click: (event: ReactMouseEvent<HTMLButtonElement>) => events.current.click(event, id),
    doubleClick: () => events.current.doubleClick(id),
    keyDown: (event: KeyboardEvent<HTMLButtonElement>) => events.current.keyDown(event, id),
    resizePointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => events.current.resizePointerDown(event, id),
  }), [id, events]);
  return (
    <>
      <button type="button" data-id={thought.id} data-thought-x={thought.x} data-thought-y={thought.y} data-thought-version={thought.version}
        data-live-generation={live?.generation} data-live-mover={mover} data-live-gesture={live?.gestureId} data-live-lease={live?.leaseId} data-live-preview-sequence={live?.sequence}
        ref={nodeRef}
        className={`sk-node sk-node--${thought.shape}${dragging ? ' is-dragging' : ''}${editing ? ' is-editing' : ''}${thought.version === 0 ? ' is-new' : ''}${linked?.count ? ' has-work' : ''}`}
        style={{ transform: `translate(${x}px, ${y}px)`, width: w, minHeight: thought.shape === 'circle' ? w : thought.height, height: thought.shape === 'circle' ? w : undefined }}
        aria-pressed={selected} aria-describedby={helpId}
        onPointerDown={handlers.pointerDown}
        onPointerEnter={handlers.pointerEnter} onPointerLeave={handlers.pointerLeave}
        onClick={handlers.click}
        onDoubleClick={handlers.doubleClick}
        onKeyDown={handlers.keyDown}>
        <ThoughtContent text={thought.text} placement={thought.placement} file={thought.file} source={thought.source}
          createdBy={thought.createdBy} createdAt={thought.createdAt} version={thought.version} height={thought.height}
          meId={meId} linked={linked} mover={mover} />
        {resizable ? <span className="sk-resize" aria-hidden="true" onPointerDown={handlers.resizePointerDown} /> : null}
      </button>
      {linked?.count && projectId ? (
        <div className={`sk-work-slot sk-work-slot--${thought.shape}${dragging ? ' is-dragging' : ''}`} data-for={thought.id} style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}>
          <ThoughtWork id={thought.id} text={thought.text} linked={linked} projectId={projectId} events={events} />
        </div>
      ) : null}
    </>
  );
});

/** Preview coordinates and lease sequences change every movement; the native content does not.
 * Explicit content props let React's ordinary memo comparison keep the body while the button's
 * geometry, live attributes and input handlers continue to use the current thought. */
const ThoughtContent = memo(function ThoughtContent(props: Pick<Thought, 'text' | 'placement' | 'file' | 'source' | 'createdBy' | 'createdAt' | 'version' | 'height'> & {
  meId: string; linked: ThoughtTasksEntry | undefined; mover: string | undefined;
}) {
  const { text, placement, file, height, meId, linked, mover } = props;
  const link = linkOf(text);
  const meta = placement ? (placement.title ? `Draft · ${placement.title}` : 'Draft you can’t open') : link ? `Link · ${link.host}` : null;
  return <>
    {meta ? <span className="sk-k"><Icon name={placement ? 'doc' : 'link'} size={12} />{meta}</span> : null}
    {file ? <ThoughtImage className="sk-img" fileId={file.id} name={file.name} style={{ maxHeight: Math.max(48, height - 64) }} /> : null}
    <span className={`sk-t${link ? ' sk-t--link' : ''}`}>{text}</span>
    <span className="sk-p">{provenance(props, meId)}</span>
    {linked?.tasks[0] ? <span className="sk-taskline"><StatusGlyph status={linked.tasks[0].status} size={14} /><span>{taskNumber(linked.tasks[0])} {STATUS_LABEL[linked.tasks[0].status]}{linked.tasks[0].owner ? ` · ${linked.tasks[0].owner.name}` : ''}</span></span> : null}
    {mover ? <span className="sk-live-mover">{mover} is moving</span> : null}
    {/* Room for the count, which is its own button beside this one. */}
    {linked?.count ? <span className="sk-work-gap" aria-hidden="true" /> : null}
  </>;
});

const ThoughtWork = memo(function ThoughtWork({ id, text, linked, projectId, events }: {
  id: string; text: string; linked: ThoughtTasksEntry; projectId: string; events: { readonly current: NodeEvents };
}) {
  return <ThoughtTasks thought={{ id, text }} tasks={linked} projectId={projectId} variant="map" onOpenTask={(taskId) => events.current.openTask(taskId)} />;
});

/** Plane positions are signed: the map has no edge at 0 (#509), only the contract's limit. */
function bounded(value: number) {
  return clamp(value, -SKETCH_LIMITS.coordinate, SKETCH_LIMITS.coordinate);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
