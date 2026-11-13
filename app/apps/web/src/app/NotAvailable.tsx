import { Link } from 'react-router';
import { EmptyState } from '../ui';

/**
 * A place that is gone, closed to this person or never existed: one pattern for every kind of place (README §7, #1371). An icon, one plain
 * sentence and one way back, inside the shell and under its header. It never says why: a place nobody may open is not told apart from one that is gone.
 */
export function NotAvailable({ title, back = { to: '/', label: 'Go to Home' }, bare = false }: { title: string; back?: { to: string; label: string }; bare?: boolean }) {
  const state = <EmptyState icon="search" title={title} action={<Link className="ui-btn ui-btn--secondary" to={back.to}>{back.label}</Link>} />;
  // Without a shell (the first read of the app was refused) it is the whole page.
  if (bare) return <main className="page-center" data-not-available="">{state}</main>;
  return (
    <div className="pane-scroll"><div className="pane-in" role="status" data-not-available="">
      {state}
    </div></div>
  );
}
