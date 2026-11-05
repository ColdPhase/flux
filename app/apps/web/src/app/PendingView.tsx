import { useEffect, useState } from 'react';
import { Opening } from '../ui';

/** What a view is made of, for the quiet bars that stand in for it while its code and reads arrive. */
export type PendingKind = 'feed' | 'list' | 'cards' | 'wiki';

/**
 * The shape of the view a navigation is going to (#863, docs/design/motion.md rule 2): a project's conversation and a direct message are
 * a feed, the Map and the Sketchbook are cards, the Wiki is an index beside a page, everything else (Tasks, Inbox, Settings, …) a list.
 * `view` is `routeView(path)`.
 */
export function pendingKind(view: string): PendingKind {
  if (/^\/projects\/[^/]+\/conversation$/.test(view) || /^\/dm\/[^/]+$/.test(view)) return 'feed';
  if (/^\/projects\/[^/]+\/map$/.test(view) || view === '/map' || /^\/dm\/[^/]+\/sketches$/.test(view)) return 'cards';
  if (/^\/projects\/[^/]+\/docs$/.test(view) || view === '/docs' || view.startsWith('/materials/')) return 'wiki';
  return 'list';
}

const bars = (count: number, widths: number[]) => Array.from({ length: count }, (_, index) => <b key={index} style={{ width: `${widths[index % widths.length]}%` }} />);

/**
 * The calm loading state of the screen a switch is going to. It stands in the content area from the frame the switch is made on, over
 * the old view (which stays mounted, so its draft and scroll place are intact if the switch is cancelled), and is replaced by the
 * real view in the same layout when its code and reads are here. It is decoration: the "Opening …" row of the navigation
 * (`RouteProgress`) says in words that something is loading, once the wait is long enough to need saying.
 */
export function PendingView({ view, name }: { view: string; name: string }) {
  const kind = pendingKind(view);
  return (
    <div className={`pending-view pending-view--${kind}`} data-pending-view={view} aria-hidden="true">
      {kind === 'feed' ? <Opening name={name} /> : kind === 'wiki' ? (
        <div className="pending-view__wiki">
          <div className="pending-view__index">{bars(7, [70, 55, 82, 48, 64, 76, 52])}</div>
          <div className="pending-view__page"><b className="pending-view__title" />{bars(9, [100, 94, 98, 86, 100, 92, 70, 96, 60])}</div>
        </div>
      ) : kind === 'cards' ? (
        <div className="pending-view__cards">{Array.from({ length: 6 }, (_, index) => <div key={index} className="pending-view__card"><b style={{ width: '58%' }} /><b style={{ width: '34%' }} /></div>)}</div>
      ) : (
        <div className="pending-view__list">{Array.from({ length: 7 }, (_, index) => <div key={index} className="pending-view__row"><i /><span>{bars(1, [[62, 48, 74, 55, 68, 44, 58][index]!])}</span></div>)}</div>
      )}
    </div>
  );
}

/** How long a loading state outlasts the navigation it stands for when that ends without arriving (a cancelled switch). */
const LINGER_MS = 150;

/**
 * The view a switch is going to, while it is going: `target` is where the router's pending navigation leads (null when there is none),
 * `current` the view on show. The router's state reaches the page inside a React transition, so a render for any other, urgent
 * update (a timer, a hover) may draw the page from the state before the navigation began and show the old view for a frame or two in
 * the middle of the wait. The loading state therefore stays until the navigation has arrived (`current` is the view it was going to)
 * or has been over for `LINGER_MS` without arriving.
 */
export function useSwitching(target: string | null, current: string): string | null {
  const active = target && target !== current ? target : null;
  const [lingering, setLingering] = useState<string | null>(null);
  // Remembered as it begins and forgotten as it arrives, while rendering (a state that follows what it is rendered from).
  if (active && active !== lingering) setLingering(active);
  else if (!active && lingering && current === lingering) setLingering(null);
  // A switch that ends without arriving (cancelled) lets go a moment later.
  useEffect(() => {
    if (active || !lingering || current === lingering) return undefined;
    const timer = window.setTimeout(() => setLingering(null), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [active, current, lingering]);
  return active ?? (lingering && current !== lingering ? lingering : null);
}
