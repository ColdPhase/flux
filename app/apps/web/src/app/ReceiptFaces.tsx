import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { MessageReader } from '@flux/contracts';
import { Avatar, Button, usePop } from '../ui';
import { clock, day } from './timeFormat';
import type { Receipt } from './receipts';
import './receipt-faces.css';

/**
 * Who has read a message, as faces (#1231, docs/design/final/README.md "Time and who has read it"): at most 3 small faces and a "+N"
 * circle in one row, the same height for 1 reader or 500. The faces are one button: its name is "Seen by Maurycy"; a hover (computer)
 * or a tap (phone) opens the list with names and times, whose first 20 rows are read only then and which pages on scroll.
 */
export function ReceiptFaces({ receipt }: { receipt: Receipt }) {
  const { count, readers } = receipt;
  const faces = readers.slice(0, FACES);
  const more = count - faces.length;
  const button = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<null | 'hover' | 'pinned'>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const [byKeyboard, setByKeyboard] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const open = (next: 'hover' | 'pinned') => {
    const box = button.current?.getBoundingClientRect();
    if (box) setPlace(placement(box));
    setMode(next);
  };
  const close = useCallback((restoreFocus: boolean) => {
    window.clearTimeout(timer.current);
    setMode(null);
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  }, []);
  const leave = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setMode((current) => (current === 'hover' ? null : current)), HOVER_GRACE_MS); };

  return (
    <>
      <button ref={button} type="button" className="seen" aria-label={seenBy(faces, count)} aria-haspopup="dialog" aria-expanded={mode !== null}
        onPointerEnter={(event) => { if (event.pointerType !== 'mouse' || mode) { window.clearTimeout(timer.current); return; } window.clearTimeout(timer.current); timer.current = window.setTimeout(() => open('hover'), HOVER_WAIT_MS); }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') leave(); }}
        onClick={(event) => {
          window.clearTimeout(timer.current);
          if (mode === 'pinned') { close(false); return; }
          // detail 0 is a key press: the list takes the focus so the arrow keys scroll it.
          setByKeyboard(event.detail === 0);
          open('pinned');
        }}>
        {faces.map((reader) => <Avatar key={reader.id} name={reader.name} size="xs" />)}
        {more > 0 ? <span className="seen__more" aria-hidden="true">+{more}</span> : null}
      </button>
      {mode ? <ReaderList receipt={receipt} place={place} pinned={mode === 'pinned'} focusList={byKeyboard} onClose={close}
        onEnter={() => window.clearTimeout(timer.current)} onLeave={leave} anchor={button} /> : null}
    </>
  );
}

const FACES = 3;
/**
 * The list is drawn in the page's body, but React lets its events rise to the message it belongs to, whose touch gestures (a long press,
 * a swipe) must not start from a finger scrolling the list.
 */
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const isolated = { onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onContextMenu: stop };
/** The tooltip wait before a hover opens the list, and the grace for the pointer to cross the gap to it. */
const HOVER_WAIT_MS = 450;
const HOVER_GRACE_MS = 220;
const LIST_HEIGHT = 320;
const LIST_WIDTH = 300;
const GAP = 8;
const MARGIN = 12;

/** "Seen by Maurycy", "Seen by Maurycy and Ada", "Seen by Maurycy, Ada, Jonas and 47 others": first names, the faces' own name for a screen reader. */
export function seenBy(readers: readonly MessageReader[], count: number): string {
  const names = readers.map((reader) => reader.name.trim().split(/\s+/)[0] || reader.name);
  const others = count - names.length;
  if (others > 0) return `Seen by ${names.join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`;
  if (names.length < 2) return `Seen by ${names[0] ?? ''}`;
  return `Seen by ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Above the faces when there is room for the list, else below, and always inside the screen. */
function placement(box: DOMRect): CSSProperties {
  const above = box.top - GAP - MARGIN, below = window.innerHeight - box.bottom - GAP - MARGIN;
  const up = above >= LIST_HEIGHT || above >= below;
  // Its right edge under the faces', pulled in far enough that its left edge stays on the screen.
  const right = Math.max(MARGIN, Math.min(window.innerWidth - box.right, window.innerWidth - Math.min(LIST_WIDTH, window.innerWidth - 2 * MARGIN) - MARGIN));
  return { ...(up ? { bottom: window.innerHeight - box.top + GAP } : { top: box.bottom + GAP }), right, maxHeight: Math.min(LIST_HEIGHT, Math.max(120, up ? above : below)) };
}

/** "9:58 PM" today, "Nov 12, 9:58 PM" on another day. */
const stamp = (iso: string) => (day(iso) === 'Today' ? clock(iso) : `${day(iso)}, ${clock(iso)}`);

function ReaderList({ receipt, place, pinned, focusList, onClose, onEnter, onLeave, anchor }: {
  receipt: Receipt; place: CSSProperties; pinned: boolean; focusList: boolean; onClose: (restoreFocus: boolean) => void;
  onEnter: () => void; onLeave: () => void; anchor: { current: HTMLElement | null };
}) {
  const pop = usePop(true, { from: 'above' });
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLParagraphElement>(null);
  // The faces already read are shown at once; the list loads its first page when it opens, and then a page whenever its end is reached.
  const [rows, setRows] = useState<readonly MessageReader[]>(receipt.readers);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState(receipt.count <= receipt.readers.length);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = useRef(receipt.list);
  useEffect(() => { list.current = receipt.list; });
  // One controller for the whole life of the open list: closing it cancels a page still on its way.
  const alive = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); alive.current = controller; return () => controller.abort(); }, []);
  const remaining = receipt.count - rows.length;
  const hasMore = !started || next !== undefined;
  const more = hasMore && remaining > 0;

  const load = useCallback(async (after: string | undefined, first: boolean) => {
    const signal = alive.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setFailed(false);
    try {
      const page = await list.current(after, signal);
      if (signal.aborted) return;
      setRows((current) => (first ? page.readers : [...current, ...page.readers.filter((reader) => !current.some((known) => known.id === reader.id))]));
      setNext(page.next ?? undefined);
      setStarted(true);
    } catch { if (!signal.aborted) setFailed(true); }
    finally { if (!signal.aborted) setBusy(false); }
  }, []);

  // The end of the list asks for the next page when it comes into view; the first page is asked for the same way, as the 3 known faces
  // leave it in view the moment the list opens.
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const sentinel = end.current, root = scroller.current;
    if (!sentinel || !root || !more || busy || failed) return;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { watch.disconnect(); void load(started ? next : undefined, !started); }
    }, { root });
    watch.observe(sentinel);
    return () => watch.disconnect();
  }, [more, busy, failed, started, next, load, retry]);

  useEffect(() => { if (focusList) scroller.current?.focus({ preventScroll: true }); }, [focusList]);
  useEffect(() => {
    const surface = scroller.current?.parentElement;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (surface?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    // The list is placed once, beside the faces: moving the page or the window closes it rather than leaving it behind.
    const away = (event: Event) => { if (!surface?.contains(event.target as Node)) onClose(false); };
    // Escape works wherever the focus is: a click does not move it into the list in every browser.
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); };
  }, [anchor, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { event.preventDefault(); onClose(true); }
  };

  return createPortal(
    <>
      {pinned ? <div {...pop.props} data-pop-fade="" className="msg-menu__scrim" onPointerDown={(event) => { event.stopPropagation(); onClose(false); }} /> : null}
      <div {...pop.props} {...isolated} className="seen-list" role="dialog" aria-label="Seen by" style={place} onKeyDown={onKeyDown}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') onEnter(); }} onPointerLeave={(event) => { if (event.pointerType === 'mouse' && !pinned) onLeave(); }}>
        <div ref={scroller} className="seen-list__scroll" role="region" tabIndex={0} aria-label="People who have read this">
          <ul className="seen-list__rows">
            {rows.map((reader) => (
              <li key={reader.id} className="seen-list__row">
                <Avatar name={reader.name} size="sm" />
                <span className="seen-list__name">{reader.name}</span>
                <time className="seen-list__at" dateTime={reader.at}>{stamp(reader.at)}</time>
              </li>
            ))}
          </ul>
          {failed ? (
            <p className="seen-list__more">Couldn’t load the rest <Button variant="quiet" size="sm" onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>Try again</Button></p>
          ) : more ? <p ref={end} className="seen-list__more">and {remaining} {remaining === 1 ? 'other' : 'others'}</p> : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
