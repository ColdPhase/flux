import { Component, Suspense, createElement, lazy, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Button, ErrorState, MEDIA, Overlay, Spinner, useMediaQuery, useSidePanelMode } from '../ui';
import { pageLeaving, whenPageLive } from '../api/pageLeaving';
import { useLocation, useParams } from 'react-router';
import { useLive } from '../live/LiveProvider';
import type { Details } from './Details';
import { ReloadRecovery } from './ReloadRecovery';
import { useShellActions } from './shellContext';
import { useShellData } from './data';
import { placeOfPath, useRecentPlaces } from '../search/recent';
import { DetailsSkeleton, JumpSkeleton } from './SurfaceSkeletons';
import { conversationPage, preloadProjectViews } from './viewChunks';

/**
 * The code of one deferred surface. It is downloaded once, whoever asks first (the preload below or the surface being opened): a
 * second `import()` must not become a second request. `loaded()` is the component as soon as it has arrived, so a surface opened after
 * the preload renders at once.
 */
function deferred<P extends object>(load: () => Promise<ComponentType<P>>) {
  let component: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const download = () => (loading ??= load().then((loaded) => { component = loaded; return loaded; }, (error: unknown) => { loading = null; throw error; }));
  return { download, loaded: () => component };
}
type Deferred<P extends object> = ReturnType<typeof deferred<P>>;
const details = deferred<ComponentProps<typeof Details>>(async () => (await import('./Details')).Details);
const search = deferred<{ onClose: () => void; userId: string }>(async () => (await import('../search/JumpTo')).JumpToBody);
// The live strip is not part of the first visit's code (#1178): it comes with the other surfaces.
const liveBar = deferred<Record<string, never>>(async () => (await import('../live/LiveBar')).LiveBar);
/**
 * A deferred surface's component: put in at once when its code has arrived, else `fallback` until it does. It is not a `Suspense` boundary
 * on purpose: React holds a fallback it has shown for about 300 ms before it reveals what replaces it, so a code download that takes
 * 40 ms would still keep the skeleton up for 300. A failed download throws to the surface's boundary.
 */
function Surface<P extends object>({ of, props, fallback }: { of: Deferred<P>; props: P; fallback: ReactNode }) {
  const [Loaded, setLoaded] = useState<ComponentType<P> | null>(() => of.loaded());
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (Loaded) return undefined;
    let live = true;
    of.download().then((component) => { if (live) setLoaded(() => component); }, (error: unknown) => { if (live) setFailure({ error }); });
    return () => { live = false; };
  }, [of, Loaded]);
  if (failure) throw failure.error;
  return Loaded ? createElement(Loaded, props) : fallback;
}
const StageContent = lazy(async () => ({ default: (await import('../live/LiveStage')).LiveStage }));

/**
 * A surface opens with its content (#863 rule 6): the code of Details and Search is fetched before it is asked for, so the panel
 * and ⌘K do not open on a fallback that is then replaced. It happens when the browser is idle soon after the shell is up (the first
 * screen is already painted, and the first-load contract of `test_route_chunks` is about what that screen imports), and at once on
 * the first press of anything: a pointer going down, or ⌘ or Ctrl, which is pressed a moment before the K that opens search. Inside a
 * project the code of its other views (Tasks, Map, Wiki, Agents) comes the same way, so a switch finds it here.
 */
const PRELOAD_AFTER_MS = 1200;
const PRELOAD_IDLE_MS = 1000;
let preloaded = false;
let viewsPreloaded = false;
function preloadSurfaces() {
  if (preloaded) return;
  preloaded = true;
  void details.download().catch(() => { preloaded = false; });
  void search.download().catch(() => { preloaded = false; });
  void liveBar.download().catch(() => { preloaded = false; });
  // A space opens on its conversation, so its code is here before the first move into one (#1178).
  void conversationPage().catch(() => { preloaded = false; });
}
function preloadViews() {
  if (viewsPreloaded) return;
  viewsPreloaded = true;
  void preloadProjectViews().catch(() => { viewsPreloaded = false; });
}
/** Runs `run` when the browser is idle, a moment after now. */
function whenIdle(run: () => void) {
  const idle = window.setTimeout(() => (window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: PRELOAD_IDLE_MS }) : run()), PRELOAD_AFTER_MS);
  return () => window.clearTimeout(idle);
}
function useSurfacePreload(inProject: boolean) {
  useEffect(() => {
    if (preloaded && (viewsPreloaded || !inProject)) return undefined;
    const stop = whenIdle(() => { preloadSurfaces(); if (inProject) preloadViews(); });
    const onPress = () => { preloadSurfaces(); if (inProject) preloadViews(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Control' || event.key === 'Meta') onPress(); };
    const options = { capture: true, passive: true } as const;
    document.addEventListener('pointerdown', onPress, options);
    document.addEventListener('keydown', onKey, options);
    return () => { stop(); document.removeEventListener('pointerdown', onPress, { capture: true }); document.removeEventListener('keydown', onKey, { capture: true }); };
  }, [inProject]);
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

/** The live stage's code is the one deferred surface with no fixed layout to stand in for: a quiet line in its place. */
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
  // The panel's own layout where it is known, quiet bars where it is not (app/SurfaceSkeletons.tsx): a task opened from its row knows its title.
  const opening = <DetailsSkeleton title={typeof props.view === 'object' && 'kind' in props.view && props.view.kind === 'work' && 'title' in props.view ? props.view.title : undefined} />;
  return <SurfaceBoundary label="Details"><WhenPageLive fallback={opening}><Surface of={details} props={props} fallback={opening} /></WhenPageLive></SurfaceBoundary>;
}

export interface JumpToProps { open: boolean; onClose: () => void; userId: string }

export function DeferredJumpTo({ open, onClose, userId }: JumpToProps) {
  const projectId = useParams().projectId;
  const inProject = !!projectId;
  useSurfacePreload(inProject);
  const phone = useMediaQuery(MEDIA.phone);
  const { projects, directMessages, lockedWorkspaces } = useShellData();
  const recent = useRecentPlaces(userId);
  const here = placeOfPath(useLocation().pathname)?.key;
  const [requested, setRequested] = useState(open);
  if (open && !requested) setRequested(true);
  // A body of its own each time the dialog opens, kept through its exit: the content stays mounted while the dialog fades out, so it
  // leaves at the size it had (it used to collapse to nothing on the first frame of its exit), and one that opens again before the exit
  // is over starts afresh.
  const [opens, setOpens] = useState(open ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (open) setOpens(opens + 1); }
  if (!requested) return null;
  const closer = <Button variant="quiet" onClick={onClose}>Close search</Button>;
  // The recent places the dialog will list (up to four, not the one in view, only those that still exist): what sizes its first list.
  const places = recent.filter((place) => place.key !== here && (!place.key.startsWith('project:') || projects.some((project) => project.id === place.key.split(':')[1]))
    && (!place.key.startsWith('dm:') || directMessages.some((dm) => dm.id === place.key.split(':')[1]))).slice(0, 4).length;
  // One dialog, once: the code of Search loads inside it, so ⌘K never dims, undims and dims again. Once requested it stays
  // mounted, so its own exit animation and focus restoration stay intact.
  const wrap = (content: ReactNode) => <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Search" className="jump">{content}{closer}</Overlay>;
  return (
    <SurfaceBoundary label="Search" wrap={wrap}>
      <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Search" className="jump">
        <Surface key={opens} of={search} props={{ onClose, userId }} fallback={<JumpSkeleton places={places} locked={lockedWorkspaces.length} phone={phone} onClose={onClose} />} />
      </Overlay>
    </SurfaceBoundary>
  );
}

/** The live strip (#1178): only while there is a call or an invitation to show, with its code then. */
export function DeferredLiveBar() {
  const live = useLive();
  const shown = live.phase !== 'idle' || live.invitation !== null;
  const [requested, setRequested] = useState(() => shown || liveBar.loaded() !== null);
  if (shown && !requested) setRequested(true);
  if (!requested) return null;
  return <SurfaceBoundary label="Live session"><Surface of={liveBar} props={{}} fallback={null} /></SurfaceBoundary>;
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
  // A stage that opened by itself because someone started sharing (F-041) takes no focus, also while its code loads.
  const wrap = (content: ReactNode) => open ? <StagePlaceholder onClose={live.closeStage} focus={!live.stage.auto}>{content}</StagePlaceholder> : null;
  return <SurfaceBoundary label="Live view" wrap={wrap}><Suspense fallback={wrap(<Opening label="Live view" />)}><StageContent /></Suspense></SurfaceBoundary>;
}

function StagePlaceholder({ children, onClose, focus }: { children: ReactNode; onClose: () => void; focus: boolean }) {
  const close = useRef<HTMLButtonElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (focus) close.current?.focus({ preventScroll: true }); }, []);
  return <div className="deferred-surface--stage" role="region" aria-label="Shared screens and cameras"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    {children}<Button ref={close} onClick={onClose}>Close live view</Button>
  </div>;
}
