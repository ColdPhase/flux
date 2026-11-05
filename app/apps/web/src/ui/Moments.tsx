import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Kreska, type KreskaExpression } from './Kreska';
import { useSmallMoments } from './smallMoments';
import './moments.css';

/** The mascot for a small moment, or nothing when Settings → Appearance turned the moments off. */
export function Mascot({ expression, size = 80, className }: { expression: KreskaExpression; size?: number; className?: string }) {
  const on = useSmallMoments();
  return on ? <Kreska expression={expression} size={size} className={`mascot${className ? ` ${className}` : ''}`} /> : null;
}

const OPENING_WIDTHS = [62, 88, 74, 54];

/** Quiet placeholder rows (a face and two lines each) where messages will be: the same rows stand in a stream and in a thread. */
export function OpeningRows({ rows = OPENING_WIDTHS.length }: { rows?: number }) {
  return (
    <div className="opening__rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => OPENING_WIDTHS[index % OPENING_WIDTHS.length]!).map((width, index) => <div key={index} className="opening__row"><i /><span><b style={{ width: `${width}%` }} /><b style={{ width: `${Math.round(width / 2)}%` }} /></span></div>)}
    </div>
  );
}

/**
 * "Opening <project>…" while a project's first reads arrive: the loading face (dots flow through its
 * eyes) above quiet placeholder rows. The rows stand in the stream's place from the first frame (#863 rule 2, 6); the words
 * appear after a beat, so a fast open never flashes them. It sits over the hidden stream and is never part of the content.
 */
export function Opening({ name }: { name: string }) {
  const on = useSmallMoments();
  return (
    <div className="opening" role="status" aria-live="polite">
      <p className="opening__line">{on ? <Kreska expression="loading" size={20} /> : null}<span>Opening {name}…</span></p>
      <OpeningRows />
    </div>
  );
}

const THRESHOLD = 72;
const MAX = 120;

/** The nearest ancestor that scrolls vertically; the page itself when none does. */
function scroller(from: HTMLElement | null): HTMLElement | null {
  for (let node = from?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Pull to refresh on a touch screen: dragging down from the top of the list shows Kreska peeking over the
 * edge (surprised once it is far enough); letting go refreshes. The text says the same, so nothing depends
 * on the face. A mouse or keyboard never needs it: the list also refreshes when shown again.
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => void | Promise<void>; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const on = useSmallMoments();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef(onRefresh);
  useEffect(() => { refresh.current = onRefresh; });
  useEffect(() => {
    const host = anchor.current?.parentElement ?? null;
    let startY = 0;
    let target: HTMLElement | null = null;
    let active = false;
    let distance = 0;
    const start = (event: TouchEvent) => {
      target = scroller(host);
      active = !!event.touches[0] && (target ? target.scrollTop <= 0 : window.scrollY <= 0);
      startY = event.touches[0]?.clientY ?? 0;
      distance = 0;
    };
    const move = (event: TouchEvent) => {
      if (!active) return;
      const dy = (event.touches[0]?.clientY ?? 0) - startY;
      if (dy <= 0 || (target ? target.scrollTop > 0 : window.scrollY > 0)) { if (distance) { distance = 0; setPull(0); } return; }
      distance = Math.min(MAX, dy * 0.5);
      setPull(distance);
    };
    const end = () => {
      if (!active) return;
      active = false;
      const go = distance >= THRESHOLD;
      distance = 0;
      setPull(0);
      // The mark runs as long as the refresh does: no longer, no shorter (a refresh that does not say when it is done ends at once).
      if (go) { setRefreshing(true); void Promise.resolve(refresh.current()).finally(() => setRefreshing(false)); }
    };
    // A cancelled touch (the browser took the gesture) only resets the pull; it never refreshes.
    const cancel = () => {
      active = false;
      distance = 0;
      setPull(0);
    };
    host?.addEventListener('touchstart', start, { passive: true });
    host?.addEventListener('touchmove', move, { passive: true });
    host?.addEventListener('touchend', end);
    host?.addEventListener('touchcancel', cancel);
    return () => {
      host?.removeEventListener('touchstart', start);
      host?.removeEventListener('touchmove', move);
      host?.removeEventListener('touchend', end);
      host?.removeEventListener('touchcancel', cancel);
    };
  }, []);
  const ready = pull >= THRESHOLD;
  const text = refreshing ? 'Refreshing…' : ready ? 'Release to refresh' : 'Pull to refresh';
  return (
    <>
      <span ref={anchor} hidden />
      <div className="pull" data-ready={ready || undefined} data-refreshing={refreshing || undefined} style={{ height: refreshing ? 56 : pull }} aria-hidden={!pull && !refreshing}>
        {pull || refreshing ? <div className="pull__in">{on ? <Kreska expression={ready || refreshing ? 'surprised' : 'idle'} size={28} /> : null}<span role="status">{text}</span></div> : null}
      </div>
      {children}
    </>
  );
}
