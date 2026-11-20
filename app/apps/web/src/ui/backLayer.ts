import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Back closes what sits on top first (#1545). A sheet, a window, a picker or a menu opened over the page takes one history entry of its
 * own while it is open on a touch screen or in a window as narrow as a phone's, so the phone's Back (the gesture, the system button) closes
 * it and the next Back leaves the page, as every phone app does. The entry has the page's address and the page's router state with a mark
 * (`fluxLayer`), so the router never sees it: a Back from a layer to the page under it is taken here and closes the layer, and a Back that
 * lands on an entry a closed layer left behind (a layer closed by its own control, Esc or a choice leaves its entry; the next one takes it over)
 * is stepped over in the direction it came from, so no Back ever lands on the same page twice.
 *
 * Panels that have their own entry (a task, a decision, a thread, an agent) do not use it; computers keep their keys (Esc closes).
 */
const MARK = 'fluxLayer';
/**
 * The key of the page entry under an entry the router replaced while it was one a closed layer left behind (a space's view chosen after a sheet
 * closed by a choice): the replaced entry is still one place with the page under it, so Back from it steps over that page as it would have.
 */
const UNDER = 'fluxUnder';
const PHONE = '(hover: none), (max-width: 680px)';

interface Layer { id: number; close: () => void }
const layers: Layer[] = [];
let nextId = 1;
/** The router key of the history entry the person is on, whoever made it: entries of one place (a page and the layers it opened) share one. */
let lastKey = 'default';
/** The index of the history entry the person was last on, to tell Back from Forward when stepping over. */
let lastIndex = 0;
/** The `UNDER` of the entry the person is on: Back to that key is Back to the same place. */
let lastUnder: string | undefined;

type EntryState = Record<string, unknown>;
const entryState = (): EntryState => (window.history.state ?? {}) as EntryState;
const indexOf = (state: EntryState) => (typeof state.idx === 'number' ? state.idx : 0);
const markOf = (state: EntryState) => (typeof state[MARK] === 'number' ? state[MARK] : undefined);
const keyOf = (state: EntryState) => (state.key as string | undefined) ?? 'default';
const underOf = (state: EntryState) => (typeof state[UNDER] === 'string' ? state[UNDER] : undefined);
/** The person is now on this entry. */
function arrive(state: EntryState) {
  lastIndex = indexOf(state);
  lastKey = keyOf(state);
  lastUnder = underOf(state);
}

function onPop(event: PopStateEvent) {
  const state = entryState();
  const index = indexOf(state);
  const mark = markOf(state);
  const key = keyOf(state);
  // The same place: the entry the person was on and the one they land on share the router's key (or the one they were on was replaced over this
  // one, `UNDER`). The entry they were on is read from the history itself, never from the router, which may not have caught up with a navigation
  // that has only just begun.
  const same = key === lastKey || key === lastUnder;
  const from = lastIndex;
  lastIndex = index;
  if (layers.length) {
    lastKey = key;
    lastUnder = underOf(state);
    // Back to the page under the layers, or to the entry of a lower layer: the layers above close, and the router never sees it.
    const closing = layers.filter((layer) => mark === undefined || layer.id > mark);
    if (!closing.length) {
      // Back from the entry a closed layer left over a layer still open (a date chosen in a sheet over the Create window): the open layer is what
      // sits on top, so this Back goes on to the entry under it and closes it; it is never a Back that does nothing.
      if (same && index < from) {
        event.stopImmediatePropagation();
        window.history.go(-1);
      }
      return;
    }
    layers.splice(layers.length - closing.length, closing.length);
    if (same) event.stopImmediatePropagation();
    for (const layer of closing.reverse()) layer.close();
    return;
  }
  // An entry a closed layer left behind is never a place to stop at, from either side: it is stepped over in the direction the person was
  // going, to the page's own entry (Back) or past it (Forward). The page's own entry under it is stepped over too when it is the page the
  // person is already on (Back from the entry the layer left). Nothing has been arrived at while stepping, so the place the person is on
  // stays the one they left: the entry they land on next is judged against it.
  if ((mark !== undefined || same) && index !== from) {
    event.stopImmediatePropagation();
    window.history.go(index < from ? -1 : 1);
    return;
  }
  lastKey = key;
  lastUnder = underOf(state);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPop, true);
  // The entry the person is on, whoever made it: the router's own pushes and replaces are told here too.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      let next = data;
      if (method === 'replaceState' && data && typeof data === 'object' && markOf(data as EntryState) === undefined && underOf(data as EntryState) === undefined) {
        // The router replaces the entry the person is on (a space's view chosen, an address cleaned). When that entry is one a closed layer left
        // behind, the page's own entry is still under it and is the same place: the new entry says so, and keeps saying so through later replaces.
        const was = entryState();
        const wasMark = markOf(was);
        const under = wasMark !== undefined && !layers.some((open) => open.id === wasMark) ? keyOf(was) : underOf(was);
        if (under !== undefined) next = { ...(data as EntryState), [UNDER]: under };
      }
      original(next, unused, url);
      arrive(entryState());
    };
  }
  arrive(entryState());
}

function push(layer: Layer) {
  const state = entryState();
  const mark = markOf(state);
  if (mark !== undefined && !layers.some((open) => open.id === mark)) {
    // The entry a closed layer left behind is the page's again as this one opens: it takes it over instead of adding another.
    window.history.replaceState({ ...state, [MARK]: layer.id }, '');
  } else {
    const index = indexOf(state) + 1;
    window.history.pushState({ ...state, idx: index, [MARK]: layer.id }, '');
    lastIndex = index;
  }
  layers.push(layer);
}

/**
 * While `open`, Back closes this surface (`close` is what its own close control does). Only on a touch screen or a phone-wide window, and only
 * when `enabled`. The entry is kept when the surface closes another way and is stepped over by the next Back, so closing never touches history.
 */
export function useBackLayer(open: boolean, close: () => void, enabled = true) {
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open || !enabled || typeof window === 'undefined' || !window.matchMedia(PHONE).matches) return undefined;
    const layer: Layer = { id: nextId++, close: () => closeRef.current() };
    push(layer);
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
    };
  }, [open, enabled]);
}
