import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../ui';

/**
 * A place that is gone, closed to this person or never existed: one pattern for every kind of place (README §7, #1371). An icon, one plain
 * sentence and one way back, inside the shell and under its header. It never says why: a place nobody may open is not told apart from one that is gone.
 */
// How many "not available" pages are on screen: the phone keeps its tab bar on one, even inside a space's address, so the page is never a dead
// end without a way to Home, Spaces and the Inbox (round 14, look-a B19).
let shown = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Whether a place that is not available is the page on screen. */
export const useNotAvailableShown = () => useSyncExternalStore(subscribe, () => shown > 0, () => false);
function useShownMark(on: boolean) {
  useEffect(() => {
    if (!on) return undefined;
    shown += 1; listeners.forEach((listener) => listener());
    return () => { shown -= 1; listeners.forEach((listener) => listener()); };
  }, [on]);
}

export function NotAvailable({ title, back = { to: '/', label: 'Go to Home' }, bare = false, children }: { title: string; back?: { to: string; label: string }; bare?: boolean;
  /** What the person still holds of the place on this device, such as a map's unsaved private thought: shown under the sentence, never lost with the place. */
  children?: ReactNode }) {
  useShownMark(!bare);
  // Not a magnifier: nothing is being searched (round 14, look-a B7).
  const state = <EmptyState icon="alert" title={title} action={<Link className="ui-btn ui-btn--secondary" to={back.to}>{back.label}</Link>} />;
  // Without a shell (the first read of the app was refused) it is the whole page.
  if (bare) return <main className="page-center" data-not-available="">{state}{children}</main>;
  return (
    <div className="pane-scroll"><div className="pane-in" role="status" data-not-available="">
      {state}
      {children}
    </div></div>
  );
}

/**
 * A person who was in the company and is not any more (they left or were removed): every page of the company they can still reach (the
 * Inbox, My tasks, My map, a conversation's address) says so, in Home's words, and how to come back (personas-37 P3-4). Home and Settings
 * keep their own pages.
 */
export function NoLongerIn({ company }: { company: string }) {
  return (
    <div className="pane-scroll"><div className="pane-in" data-no-longer-in="">
      <EmptyState icon="people" title={`You’re no longer in ${company}`} action={<Link className="ui-btn ui-btn--secondary" to="/">Go to Home</Link>}>
        <p>Ask an owner or admin of the company for an invite link to come back.</p>
      </EmptyState>
    </div></div>
  );
}
