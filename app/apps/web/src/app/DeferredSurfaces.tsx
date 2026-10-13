import { Component, Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, ErrorState, MEDIA, Overlay, Spinner, useMediaQuery } from '../ui';
import { pageLeaving, whenPageLive } from '../api/pageLeaving';
import { useLive } from '../live/LiveProvider';
import type { Details } from './Details';
import type { JumpTo } from '../search/JumpTo';
import { ReloadRecovery } from './ReloadRecovery';

const DetailsContent = lazy(async () => ({ default: (await import('./Details')).Details }));
const SearchContent = lazy(async () => ({ default: (await import('../search/JumpTo')).JumpTo }));
const StageContent = lazy(async () => ({ default: (await import('../live/LiveStage')).LiveStage }));

/** An optional surface failing to download must not unmount the surrounding work or live session. */
class SurfaceBoundary extends Component<{ label: string; children: ReactNode; wrap?: (content: ReactNode) => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const content = <div className="deferred-surface"><ErrorState title={`${this.props.label} couldn’t be loaded`}
      actions={<ReloadRecovery />}>
      <p>Check your connection. Close this view to return to your work.</p>
    </ErrorState></div>;
    return this.props.wrap ? this.props.wrap(content) : content;
  }
}

function Opening({ label }: { label: string }) {
  return <div className="deferred-surface"><p role="status"><Spinner />Opening {label.toLowerCase()}…</p></div>;
}

/**
 * Shows its content once the page is not being left (#471). A panel the app opens by itself, from an
 * address, can mount in the moment the person navigates away; its mount-time reads would then start
 * on a page the browser is already closing. A page that stays shows it after the short grace.
 */
function WhenPageLive({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [live, setLive] = useState(() => !pageLeaving());
  useEffect(() => (live ? undefined : whenPageLive(() => setLive(true))), [live]);
  return live ? children : fallback;
}

/** SidePanel itself owns mount/exit/focus; this content is never rendered while initially closed. */
export function DeferredDetails(props: ComponentProps<typeof Details>) {
  const opening = <Opening label="Details" />;
  return <SurfaceBoundary label="Details"><Suspense fallback={opening}><WhenPageLive fallback={opening}><DetailsContent {...props} /></WhenPageLive></Suspense></SurfaceBoundary>;
}

export function DeferredJumpTo(props: ComponentProps<typeof JumpTo>) {
  const phone = useMediaQuery(MEDIA.phone);
  const [requested, setRequested] = useState(props.open);
  if (props.open && !requested) setRequested(true);
  if (!requested) return null;
  // Once requested, leave JumpTo mounted so its own exit animation and focus restoration stay intact.
  const wrap = (content: ReactNode) => <Overlay open={props.open} onClose={props.onClose} placement={phone ? 'bottom' : 'center'} label="Jump to" className="jump">
    {content}<Button variant="quiet" onClick={props.onClose}>Close search</Button>
  </Overlay>;
  return <SurfaceBoundary label="Search" wrap={wrap}><Suspense fallback={wrap(<Opening label="Search" />)}><SearchContent {...props} /></Suspense></SurfaceBoundary>;
}

export function DeferredLiveStage() {
  const live = useLive();
  const [requested, setRequested] = useState(false);
  const open = live.stage.open && !!((live.media?.screens.length ?? 0) + (live.media?.cameras.length ?? 0)) && live.phase !== 'idle';
  if (open && !requested) setRequested(true);
  if (!requested) return null;
  const wrap = (content: ReactNode) => open ? <StagePlaceholder onClose={live.closeStage}>{content}</StagePlaceholder> : null;
  return <SurfaceBoundary label="Live view" wrap={wrap}><Suspense fallback={wrap(<Opening label="Live view" />)}><StageContent /></Suspense></SurfaceBoundary>;
}

function StagePlaceholder({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { close.current?.focus({ preventScroll: true }); }, []);
  return <div className="deferred-surface--stage" role="region" aria-label="Shared screens and cameras"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    {children}<Button ref={close} onClick={onClose}>Close live view</Button>
  </div>;
}
