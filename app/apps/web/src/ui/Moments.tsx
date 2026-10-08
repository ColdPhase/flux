import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Kreska, type KreskaExpression } from './Kreska';
import { goalMomentSeen, markGoalMomentSeen, useMoments } from './moments';
import './moments.css';

/** The mascot for a small moment, or nothing when Settings → Appearance turned the moments off. */
export function Mascot({ expression, size = 80, className }: { expression: KreskaExpression; size?: number; className?: string }) {
  const on = useMoments();
  return on ? <Kreska expression={expression} size={size} className={`mascot${className ? ` ${className}` : ''}`} /> : null;
}

/**
 * "Opening <project>…" while a project's first reads arrive: the loading face (dots flow through its
 * eyes) above quiet placeholder rows. The text stays; it appears only after a beat, so a fast open never
 * flashes it. It sits over the hidden stream and is never part of the content.
 */
export function Opening({ name }: { name: string }) {
  const on = useMoments();
  return (
    <div className="opening" role="status" aria-live="polite">
      <p className="opening__line">{on ? <Kreska expression="loading" size={20} /> : null}<span>Opening {name}…</span></p>
      <div className="opening__rows" aria-hidden="true">
        {[62, 88, 74, 54].map((width, index) => <div key={index} className="opening__row"><i /><span><b style={{ width: `${width}%` }} /><b style={{ width: `${Math.round(width / 2)}%` }} /></span></div>)}
      </div>
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
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => void; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const on = useMoments();
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
      if (go) { setRefreshing(true); refresh.current(); window.setTimeout(() => setRefreshing(false), 900); }
    };
    host?.addEventListener('touchstart', start, { passive: true });
    host?.addEventListener('touchmove', move, { passive: true });
    host?.addEventListener('touchend', end);
    host?.addEventListener('touchcancel', end);
    return () => {
      host?.removeEventListener('touchstart', start);
      host?.removeEventListener('touchmove', move);
      host?.removeEventListener('touchend', end);
      host?.removeEventListener('touchcancel', end);
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

/**
 * A project goal was reached: Celebrate once per goal, with the goal in words beside it and no confetti.
 * It stays where it is (never over content) and never returns for the same goal on this device.
 */
export function GoalReached({ goalId, title, project, actions }: { goalId: string; title: string; project: string; actions?: ReactNode }) {
  const [first] = useState(() => !goalMomentSeen(goalId));
  const on = useMoments();
  useEffect(() => { if (first) markGoalMomentSeen(goalId); }, [first, goalId]);
  return (
    <section className="goal" aria-label="Goal reached">
      {on && first ? <Kreska expression="celebrate" size={88} /> : null}
      <h2 className="goal__title">{title}</h2>
      <p className="goal__sub">{project} · goal reached</p>
      {actions ? <div className="goal__actions">{actions}</div> : null}
    </section>
  );
}
