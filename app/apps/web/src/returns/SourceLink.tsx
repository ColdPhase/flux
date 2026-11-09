import type { MouseEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { ReturnSource } from '@flux/contracts';
import { useShellActions } from '../app/shellContext';
import { sourceHref } from './api';
import { RefLink } from '../place/origin';

/** Opens a source: a link for messages, materials and maps; Details on the space for work objects (Home's "Continue where you left off"). */
export function SourceLink({ source, className, children, label, onFollow }: { source: ReturnSource; className: string; children: ReactNode; label?: string; onFollow?: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { openDetails } = useShellActions();
  const href = sourceHref(source);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) onFollow?.();
    if (source.type !== 'work' && source.type !== 'decision') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    // Already on the space: open Details in place and keep the conversation where it is. From elsewhere the space
    // opens it on arrival (`?open=`), as a notification's link does: a panel never follows the person between places (H11-8).
    if (pathname.startsWith(href)) openDetails({ kind: source.type, id: source.id });
    else navigate(`${href}?open=${source.type}:${source.id}`);
  };
  return <RefLink to={href} className={className} onClick={onClick} aria-label={label}>{children}</RefLink>;
}
