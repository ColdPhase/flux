import { Component, Suspense, createElement, lazy, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Button, ErrorState, MEDIA, Overlay, Spinner, useMediaQuery, useSidePanelMode } from '../ui';
import { pageLeaving, whenPageLive } from '../api/pageLeaving';
import { useLive } from '../live/LiveProvider';
import type { Details } from './Details';
import { ReloadRecovery } from './ReloadRecovery';
import { useShellActions } from './shellContext';

/**
 * The code of one deferred surface. It is downloaded once, whoever asks first (the preload below or the surface being opened): a
 * second `import()` must not become a second request. `loaded()` is the component as soon as it has arrived, so a surface opened after
 * the preload renders at once; a `lazy` component always suspends once, and React then holds a fallback it has just shown for about
 * 300 ms before it puts the content in its place. `Lazy` is for a surface asked for before its code is here.
 */
function deferred<P extends object>(load: () => Promise<ComponentType<P>>) {
  let component: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const download = () => (loading ??= load().then((loaded) => { component = loaded; return loaded; }, (error: unknown) => { loading = null; throw error; }));
  const Lazy = lazy(async () => ({ default: await download() }));
  return { download, loaded: () => component, Lazy };
}
type Deferred<P extends object> = ReturnType<typeof deferred<P>>;
const details = deferred<ComponentProps<typeof Details>>(async () => (await import('./Details')).Details);
const search = deferred<{ onClose: () => void; userId: string }>(async () => (await import('../search/JumpTo')).JumpToBody);
/** A deferred surface's component: put in at once when its code has arrived, else suspending until it does. */
function Surface<P extends object>({ of, props }: { of: Deferred<P>; props: P }) {
  return createElement((of.loaded() ?? of.Lazy) as ComponentType<P>, props);
}
const StageContent = lazy(async () => ({ default: (await import('../live/LiveStage')).LiveStage }));

/**
 * A surface opens with its content (#863 rule 6): the code of Details and Jump to… is fetched before it is asked for, so the panel
 * and ⌘K do not open on a fallback that is then replaced. It happens when the browser is idle a couple of seconds after the shell is up
 * (the first screen stays as light as it was and no action in the first seconds competes with it), and at once on ⌘ or Ctrl, which
 * is pressed a moment before the K that opens search.
 */
const PRELOAD_AFTER_MS = 2000;
const PRELOAD_IDLE_MS = 1000;
let preloaded = false;
function preloadSurfaces() {
  if (preloaded) return;
  preloaded = true;
  void details.download().catch(() => { preloaded = false; });
  void search.download().catch(() => { preloaded = false; });
}
function useSurfacePreload() {
  useEffect(() => {
    if (preloaded) return undefined;
    const idle = window.setTimeout(() => (window.requestIdleCallback ? window.requestIdleCallback(preloadSurfaces, { timeout: PRELOAD_IDLE_MS }) : preloadSurfaces()), PRELOAD_AFTER_MS);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Control' || event.key === 'Meta') preloadSurfaces(); };
    document.addEventListener('keydown', onKey, { capture: true, passive: true });
    return () => { window.clearTimeout(idle); document.removeEventListener('keydown', onKey, { capture: true }); };
  }, []);
}

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
  return <SurfaceBoundary label="Details"><Suspense fallback={opening}><WhenPageLive fallback={opening}><Surface of={details} props={props} /></WhenPageLive></Suspense></SurfaceBoundary>;
}

export interface JumpToProps { open: boolean; onClose: () => void; userId: string }

export function DeferredJumpTo({ open, onClose, userId }: JumpToProps) {
  useSurfacePreload();
  const phone = useMediaQuery(MEDIA.phone);
  const [requested, setRequested] = useState(open);
  if (open && !requested) setRequested(true);
  if (!requested) return null;
  const closer = <Button variant="quiet" onClick={onClose}>Close search</Button>;
  // One dialog, once: the code of Jump to… loads inside it, so ⌘K never dims, undims and dims again. Once requested it stays
  // mounted, so its own exit animation and focus restoration stay intact.
  const wrap = (content: ReactNode) => <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Jump to" className="jump">{content}{closer}</Overlay>;
  return (
    <SurfaceBoundary label="Search" wrap={wrap}>
      <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Jump to" className="jump">
        <Suspense fallback={<><Opening label="Search" />{closer}</>}>{open ? <Surface of={search} props={{ onClose, userId }} /> : null}</Suspense>
      </Overlay>
    </SurfaceBoundary>
  );
}

export function DeferredLiveStage() {
  const live = useLive();
  const [requested, setRequested] = useState(false);
  const open = live.stage.open && !!((live.media?.screens.length ?? 0) + (live.media?.cameras.length ?? 0)) && live.phase !== 'idle';
  if (open && !requested) setRequested(true);
  // The strip stays usable above a thread or Details sheet (a modal that covers the pane), so its View can open
  // the stage under that sheet. The stage takes the pane, as the sheet's scrim would hide Back to work: the sheet closes.
  const { closePanel } = useShellActions();
  const panelMode = useSidePanelMode();
  useEffect(() => {
    if (open && panelMode !== 'docked' && document.getElementById('details')) closePanel();
    // Once per time the stage opens; closePanel is a fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
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
