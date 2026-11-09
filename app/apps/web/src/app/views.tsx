import { useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '../ui';
import { useShellData } from './data';
import { useReadingPosition } from '../drafts/store';

/** A view's scroll area. Its reading position is kept per account and view across switches and reloads. */
function Pane({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { me } = useShellData();
  useReadingPosition(ref, me.user.id, useLocation().pathname);
  return (
    <div className="pane-scroll" ref={ref}>
      <div className="pane-in">{children}</div>
    </div>
  );
}

export function NotFoundView() {
  return (
    <Pane>
      <div className="view-empty">
        <EmptyState icon="search" title="This page doesn’t exist" action={<Link className="ui-btn ui-btn--secondary" to="/">Go to Home</Link>}>
          <p>The address may be mistyped, or what it pointed to was moved.</p>
        </EmptyState>
      </div>
    </Pane>
  );
}
