import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, type LinkProps, type NavigateOptions, type To } from 'react-router';
import { ApiError } from '../api/client';
import { getProject } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { Icon } from '../ui';
import { currentEntry, flushPlace, type ReturnState } from './memory';

/**
 * "‹ where I came from" (#592). Following a reference inside Flux pushes one history entry whose state carries the
 * place it was followed from; the destination shows one quiet control for it, and Back returns to that entry. The
 * origin is only ever in `history.state`: never in the address, never on the server. Docs:
 * docs/development/return-to-origin.md.
 */
export interface Origin {
  /** The router key of the entry the reference was followed from: its place is kept under this key. */
  key: string;
  /** Its address, to return to when there is no earlier entry to step back to. */
  path: string;
  /** Its name for the control: "Conversation", "Thread", "Tasks", "#12 Order sensors". */
  label: string;
}

export function originOf(state: unknown): Origin | null {
  const value = state && typeof state === 'object' ? (state as { origin?: unknown }).origin : null;
  if (!value || typeof value !== 'object') return null;
  const { key, path, label } = value as Partial<Origin>;
  return typeof key === 'string' && typeof path === 'string' && typeof label === 'string' && label.trim() ? { key, path, label } : null;
}

const withoutHash = (path: string) => path.replace(/#.*$/, '');

/** A screen can name itself more exactly than its address does (a task's thread is "#12 Order sensors"). */
let named: string | null = null;
export function useOriginLabel(label: string | null) {
  useEffect(() => {
    named = label;
    return () => { if (named === label) named = null; };
  }, [label]);
}

/** What a place is called in the control, from its address, when the screen has not named itself. */
export function labelFor(pathname: string): string {
  if (/^\/projects\/[^/]+\/conversations\//.test(pathname)) return 'Thread';
  if (/^\/projects\/[^/]+\/tasks(\/|$)/.test(pathname) || /^\/tasks(\/|$)/.test(pathname)) return 'Tasks';
  if (/^\/projects\/[^/]+\/map(\/|$)/.test(pathname)) return 'Map';
  if (/^\/projects\/[^/]+\/docs(\/|$)/.test(pathname) || /^\/docs(\/|$)/.test(pathname) || /^\/materials\//.test(pathname)) return 'Wiki';
  if (/^\/projects\/[^/]+\/agents(\/|$)/.test(pathname)) return 'Agents';
  if (/^\/projects\/[^/]+\/github(\/|$)/.test(pathname)) return 'GitHub settings';
  if (/^\/projects\/[^/]+\/live\//.test(pathname)) return 'Live session';
  if (pathname === '/projects') return 'Projects';
  if (/^\/projects\/[^/]+\/?$/.test(pathname)) return 'Conversation';
  if (pathname.startsWith('/search')) return 'Search';
  if (pathname.startsWith('/inbox')) return 'Inbox';
  if (/^\/dm\/[^/]+\/sketches/.test(pathname)) return 'Sketches';
  if (pathname === '/dm' || pathname.startsWith('/dm/')) return 'Messages';
  if (pathname.startsWith('/map')) return 'Sketchbook';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Home';
}

/** The place being left, as the control will name it. */
export const placeLabel = (pathname = window.location.pathname) => named ?? labelFor(pathname);

/** The origin a followed reference carries: the entry on screen, as it is this instant. */
export function originHere(label: string = placeLabel()): Origin {
  return { key: currentEntry().key, path: `${window.location.pathname}${window.location.search}${window.location.hash}`, label };
}

/**
 * Opens a reference: one history entry that remembers where it was followed from. Panels and threads keep their
 * replace semantics; only following a reference to another object or page goes through here.
 */
export function useFollow() {
  const navigate = useNavigate();
  return useCallback((to: To, options: NavigateOptions = {}) => {
    flushPlace();
    const state = options.state && typeof options.state === 'object' ? options.state as object : {};
    return navigate(to, { ...options, state: { ...state, origin: originHere() } });
  }, [navigate]);
}

/** A link to another object or page that remembers where it was followed from. A new tab or window gets the plain link. */
export function RefLink({ to, replace, state, onClick, ...rest }: LinkProps) {
  const follow = useFollow();
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.reloadDocument || (rest.target && rest.target !== '_self')) return;
    event.preventDefault();
    void follow(to, { replace, ...(state === undefined ? {} : { state }), preventScrollReset: rest.preventScrollReset, relative: rest.relative });
  };
  return <Link {...rest} to={to} replace={replace} state={state} onClick={click} />;
}

const projectOf = (path: string) => /^\/projects\/([0-9a-f-]{36})(\/|$|\?|#)/i.exec(path)?.[1];
const dmOf = (path: string) => /^\/dm\/([0-9a-f-]{36})(\/|$|\?|#)/i.exec(path)?.[1];

/**
 * The origin of the screen on show, when it still leads somewhere the person can open: not this same page, not a
 * project they lost access to (shell list, then one read), not a direct message that left their list.
 */
export function useRouteOrigin(): Origin | null {
  const location = useLocation();
  const { projects, directMessages } = useShellData();
  const origin = originOf(location.state);
  const project = origin ? projectOf(origin.path) : undefined;
  const dm = origin ? dmOf(origin.path) : undefined;
  const [lost, setLost] = useState<string | null>(null);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    getProject(project, controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted && cause instanceof ApiError && [401, 403, 404].includes(cause.status)) setLost(project);
    });
    return () => controller.abort();
  }, [project, location.key]);
  if (!origin || withoutHash(origin.path) === `${location.pathname}${location.search}`) return null;
  if (project && (lost === project || !projects.some((item) => item.id === project))) return null;
  if (dm && !directMessages.some((item) => item.id === dm)) return null;
  return origin;
}

/** Back to the origin: one step back in history, so Forward leads to this object again; or its address when there is no earlier entry. */
export function useGoToOrigin(origin: Origin) {
  const navigate = useNavigate();
  return useCallback(() => {
    flushPlace();
    const index = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof index === 'number' && index > 0) { void navigate(-1); return; }
    void navigate(origin.path, { state: { restore: { key: origin.key, path: withoutHash(origin.path) } } satisfies ReturnState });
  }, [navigate, origin]);
}

/** The one quiet "‹ <origin name>" control, wherever an opened reference shows its head: the header row, the panel's head, the phone's sheet. */
export function OriginBack({ label, onClick, className = '' }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`origin-back${className ? ` ${className}` : ''}`} data-origin-back="" aria-label={`Back to ${label}`} title={`Back to ${label}`} onClick={onClick}>
      <Icon name="chevron-left" size={14} />
      <span className="origin-back__label">{label}</span>
    </button>
  );
}

/** The control for an opened page: back to the entry its reference was followed from. */
export function RouteOriginBack({ origin, className }: { origin: Origin; className?: string }) {
  const go = useGoToOrigin(origin);
  return <OriginBack label={origin.label} onClick={go} className={className} />;
}

/** A panel's own labels: what the open object is called, so the panel that replaces it can lead back to it. */
export const PanelLabelContext = createContext<(label: string | null) => void>(() => undefined);
export function usePanelLabel(label: string | null) {
  const set = useContext(PanelLabelContext);
  useEffect(() => {
    set(label);
    return () => set(null);
  }, [label, set]);
}
