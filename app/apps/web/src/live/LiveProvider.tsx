import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import type { LivePresentation, LiveSession, ProjectPerson } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useToast } from '../ui';
import { listProjectPeople } from '../project/data';
import { anchorLabel, anchorPath, sameContext, resolveFragment, type LiveAnchor, type Presentable, type ResolvedFragment } from './anchors';
import {
  discoverSessions, getSession, joinSession, leaveSession, listPresentations, liveCapability, pendingInvitations,
  presentInSession, replyToInvitation, startSession, type LiveCapability,
} from './api';
import type { DeviceKind, LiveMediaConnection, MediaSnapshot } from './media';

/**
 * One live session per tab (#59 §2): it lives above the routes, so moving between the
 * conversation, a task, the map and a doc keeps the same connection. Starting or joining
 * never asks for a device. Nothing here changes work: saved results stay in their objects.
 */

export type Phase = 'idle' | 'starting' | 'joining' | 'in' | 'rejoining' | 'ended';

export interface ShownFragment {
  presentation: LivePresentation;
  fragment: ResolvedFragment;
  /** Arrived after you joined (the latest earlier one is kept quietly). */
  fresh: boolean;
}

export interface PendingInvitation {
  invitationId: string;
  sessionId: string;
  projectId: string;
  inviterId: string;
  anchor: LiveAnchor;
}

export interface LiveValue {
  capability: LiveCapability | 'loading';
  phase: Phase;
  session: LiveSession | null;
  anchor: LiveAnchor | null;
  /** A calm sentence about the last ending or failure. */
  notice: string | null;
  media: MediaSnapshot | null;
  quiet: boolean;
  following: string | null;
  shown: ShownFragment | null;
  invitation: PendingInvitation | null;
  /** Names of the session project's people; "You" for yourself. */
  nameOf(userId: string): string;
  /** The person's own name, also for yourself (initials on faces). */
  fullName(userId: string): string;
  people: ProjectPerson[];
  meId: string;
  start(anchor: LiveAnchor): Promise<void>;
  join(session: LiveSession, anchor?: LiveAnchor): Promise<void>;
  leave(): Promise<void>;
  setDevice(kind: DeviceKind, on: boolean): Promise<void>;
  setQuiet(on: boolean): void;
  startAudio(): Promise<void>;
  present(item: Presentable): Promise<boolean>;
  view(shown: ShownFragment): void;
  follow(userId: string | null): void;
  answerInvitation(choice: 'join' | 'later' | 'text'): Promise<void>;
  dismissNotice(): void;
  diagnostics: LiveMediaConnection['diagnostics'] | null;
  /** The screen and camera view over the work area, opened on request only. */
  stage: { open: boolean; focus: string | null };
  openStage(focus?: string | null): void;
  closeStage(): void;
}

interface HereEntry { anchor: LiveAnchor | null; presentable: Presentable | null }
export interface Here { anchor: LiveAnchor | null; presentable: Presentable | null }

const LiveContext = createContext<LiveValue | null>(null);
const HereContext = createContext<{ register(entry: HereEntry): () => void; here: Here }>({ register: () => () => undefined, here: { anchor: null, presentable: null } });

const EMPTY_SNAPSHOT_SUBSCRIBE = () => () => undefined;
const nullSnapshot = () => null;

export function useLive(): LiveValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error('useLive outside LiveProvider');
  return value;
}

/** The anchor and fragment of whatever the person is looking at now (the Details panel wins). */
export function useLiveHere(): Here {
  return useContext(HereContext).here;
}

/**
 * A view says where the person is (an anchor for "Work on this together") and what it could
 * show ("Show this"). It never publishes anything by itself: private navigation is private.
 */
export function useRegisterLiveHere(anchor: LiveAnchor | null, presentable: Presentable | null) {
  const { register } = useContext(HereContext);
  const key = JSON.stringify([anchor, presentable]);
  useEffect(() => register({ anchor, presentable }),
    // The key captures the content; the objects are rebuilt on every render by callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, register]);
}

function readable(error: unknown): string {
  if (error instanceof NetworkError) return 'Flux could not be reached. Your work is safe; try again in a moment.';
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This session is no longer available to you.';
    if (error.status === 429) return 'Too many attempts. Wait a few seconds, then try again.';
    if (error.code === 'LIVE_SESSION_LIMIT')
      return 'This project already has as many live sessions as it allows. Join one that is running.';
    if (error.status === 503) return 'The media server is not reachable right now. Text work is unaffected.';
    if (error.code === 'LIVE_SESSION_ENDED' || error.code === 'LIVE_SESSION_UNAVAILABLE') return 'This session has ended.';
    return error.message;
  }
  return 'The live connection failed. Your work is safe; try again.';
}

const REJOIN_DELAYS = [800, 2500, 6000];

export function LiveProvider({ meId, children }: { meId: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [capability, setCapability] = useState<LiveCapability | 'loading'>('loading');
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<LiveSession | null>(null);
  const [anchor, setAnchor] = useState<LiveAnchor | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quiet, setQuietState] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownFragment | null>(null);
  const [invitation, setInvitation] = useState<PendingInvitation | null>(null);
  const [people, setPeople] = useState<ProjectPerson[]>([]);
  const [connection, setConnection] = useState<LiveMediaConnection | null>(null);
  const [stage, setStage] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null });
  const connectionRef = useRef<LiveMediaConnection | null>(null);
  const rejoining = useRef(false);
  const cursor = useRef<string | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const sessionRef = useRef<LiveSession | null>(null);
  const quietRef = useRef(false);
  const followingRef = useRef<string | null>(null);
  useEffect(() => { phaseRef.current = phase; sessionRef.current = session; quietRef.current = quiet; followingRef.current = following; });

  const media = useSyncExternalStore(connection?.subscribe ?? EMPTY_SNAPSHOT_SUBSCRIBE, connection?.getSnapshot ?? nullSnapshot);

  // Whether this server has a media server at all. Unavailable is a normal, explained state.
  useEffect(() => {
    const controller = new AbortController();
    liveCapability(controller.signal).then(setCapability, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setCapability('unavailable');
    });
    return () => controller.abort();
  }, []);

  // The update prompt (outside this provider) says that reloading would leave the session.
  useEffect(() => {
    const on = phase === 'in' || phase === 'rejoining' || phase === 'joining';
    document.documentElement.dataset.live = on ? 'on' : 'off';
    return () => { document.documentElement.dataset.live = 'off'; };
  }, [phase]);

  // Leaving the app (sign-out, closing the tab) releases every device and the room.
  useEffect(() => () => { connection?.dispose(); }, [connection]);

  const names = useMemo(() => new Map(people.map((person) => [person.id, person.name])), [people]);
  const nameOf = useCallback((userId: string) => (userId === meId ? 'You' : names.get(userId) ?? 'Someone'), [names, meId]);
  const fullName = useCallback((userId: string) => names.get(userId) ?? (userId === meId ? 'You' : 'Someone'), [names, meId]);

  const loadPeople = useCallback((projectId: string) => {
    void listProjectPeople(projectId).then(setPeople, () => undefined);
  }, []);

  /** Reads every presentation to the end, so earlier ones are context and only new ones are news. */
  const catchUp = useCallback(async (id: string, projectId: string, initial: boolean) => {
    let after = cursor.current;
    let last: LivePresentation | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await listPresentations(id, after);
      if (result.items.length) { last = result.items.at(-1)!; after = last.id; }
      if (!result.nextAfter || !result.items.length) break;
    }
    cursor.current = after;
    if (!last || sessionRef.current?.id !== id) return;
    const fragment = await resolveFragment(projectId, last.ref);
    if (sessionRef.current?.id !== id) return;
    const fresh = !initial && last.createdBy !== meId;
    setShown({ presentation: last, fragment, fresh: fresh || last.createdBy === meId });
    // Following opens what the followed person shows; it never pulls back after you move away.
    if (fresh && followingRef.current === last.createdBy && fragment.path)
      navigate(fragment.path, { state: { liveSelect: fragment.selected ?? null, liveFollow: true } });
  }, [meId, navigate]);

  const connect = useCallback(async (target: LiveSession, targetAnchor: LiveAnchor | null, mode: 'joining' | 'rejoining') => {
    setPhase(mode);
    if (targetAnchor?.isCurrent?.() === false) throw new Error('These task details are being refreshed. Try again after they are current.');
    const grant = await joinSession(target.id);
    if (targetAnchor?.isCurrent?.() === false) {
      await leaveSession(target.id).catch(() => undefined);
      throw new Error('These task details changed while joining. Refresh them before joining again.');
    }
    let next = connectionRef.current;
    if (!next) {
      // The media SDK is loaded only when someone actually joins a session.
      const { LiveMediaConnection } = await import('./media');
      next = connectionRef.current ?? new LiveMediaConnection();
      connectionRef.current = next;
      setConnection(next);
    }
    if (targetAnchor?.isCurrent?.() === false) {
      await leaveSession(target.id).catch(() => undefined);
      throw new Error('These task details changed before connecting. Refresh them before joining again.');
    }
    await next.connect(grant.mediaUrl, grant.token);
    if (targetAnchor?.isCurrent?.() === false) {
      await next.disconnect().catch(() => undefined);
      await leaveSession(target.id).catch(() => undefined);
      throw new Error('These task details changed while connecting. Refresh them before joining again.');
    }
    next.setHearing(!quietRef.current);
    setSession(grant.session);
    sessionRef.current = grant.session;
    setAnchor(targetAnchor);
    setPhase('in');
    return grant.session;
  }, []);

  const join = useCallback(async (target: LiveSession, targetAnchor?: LiveAnchor) => {
    if (targetAnchor?.isCurrent?.() === false) return;
    if (phaseRef.current === 'in' && sessionRef.current?.id === target.id) return;
    if (phaseRef.current === 'in' || phaseRef.current === 'rejoining') await connectionRef.current?.disconnect();
    setNotice(null);
    setInvitation(null);
    setShown(null);
    setFollowing(null);
    cursor.current = null;
    let resolved = targetAnchor ?? null;
    try {
      if (!resolved) {
        const label = await anchorLabel(target.projectId, target.context);
        if (label === null) throw new ApiError(404, 'LIVE_CONTEXT_NOT_FOUND', 'Not found');
        resolved = { projectId: target.projectId, context: target.context, label };
      }
      if (resolved.isCurrent?.() === false) { setPhase('idle'); return; }
      loadPeople(target.projectId);
      const joined = await connect(target, resolved, 'joining');
      await catchUp(joined.id, joined.projectId, true).catch(() => undefined);
    } catch (error) {
      setPhase('idle');
      setSession(null);
      await connectionRef.current?.disconnect().catch(() => undefined);
      toast({ message: readable(error), tone: 'danger' });
    }
  }, [catchUp, connect, loadPeople, toast]);

  const start = useCallback(async (target: LiveAnchor) => {
    if (target.isCurrent?.() === false) return;
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') return;
    setPhase('starting');
    try {
      // Someone may have started one here a moment ago: join it instead of opening a second.
      const running = await discoverSessions(target.projectId).then((page) => page.items, () => [] as LiveSession[]);
      if (target.isCurrent?.() === false) { setPhase('idle'); return; }
      const existing = running.find((item) => sameContext(item.context, target.context));
      const created = existing ?? await startSession(target.context, crypto.randomUUID());
      if (target.isCurrent?.() === false) { setPhase('idle'); return; }
      await join(created, target);
    } catch (error) {
      setPhase('idle');
      toast({ message: readable(error), tone: 'danger' });
    }
  }, [join, toast]);

  const leave = useCallback(async () => {
    const current = sessionRef.current;
    setPhase('idle');
    setSession(null);
    setShown(null);
    setFollowing(null);
    setQuietState(false);
    const alone = (media?.people.filter((person) => !person.local).length ?? 0) === 0;
    rejoining.current = false;
    setStage({ open: false, focus: null });
    await connectionRef.current?.disconnect().catch(() => undefined);
    if (current) await leaveSession(current.id).catch(() => undefined);
    toast({ message: alone ? 'You left. Nobody else was here, so the session closes shortly. Your work is saved.' : 'You left the session. Everything you saved stays where it is.' });
  }, [media, toast]);

  // The connection dropped without you leaving: rejoin through Flux (current access is
  // checked again, and a replaced room is joined fresh). Devices stay off afterwards.
  const anchorRef = useRef<LiveAnchor | null>(null);
  useEffect(() => { anchorRef.current = anchor; });
  const onDrop = useCallback((endReason: MediaSnapshot['endReason']) => {
    const current = sessionRef.current;
    if (!current || endReason === 'left') return;
    if (endReason === 'elsewhere' || endReason === 'removed') {
      setPhase('ended'); setSession(null); setShown(null); setFollowing(null);
      setNotice(endReason === 'elsewhere'
        ? 'You joined this session from another window, so this one stopped. Nothing was lost.'
        : 'You were disconnected from the session, for example by leaving in another window or signing out.');
      return;
    }
    rejoining.current = true;
    setPhase('rejoining');
    void (async () => {
      for (const delay of REJOIN_DELAYS) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (!rejoining.current) return;
        try {
          const fresh = await getSession(current.id);
          if (fresh.state === 'ending' || fresh.state === 'ended') break;
          if (!rejoining.current) return;
          await connect(fresh, anchorRef.current, 'rejoining');
          rejoining.current = false;
          toast({ message: 'Reconnected. Your microphone, camera and screen stay off until you turn them on.' });
          return;
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) break;
        }
      }
      if (!rejoining.current) return;
      rejoining.current = false;
      await connectionRef.current?.disconnect().catch(() => undefined);
      setPhase('ended');
      setSession(null);
      setShown(null);
      setFollowing(null);
      setNotice('The live session ended or can no longer be reached. Nothing you saved was lost.');
    })();
  }, [connect, toast]);
  useEffect(() => {
    if (!connection) return;
    return connection.subscribe(() => {
      const snapshot = connection.getSnapshot();
      if (snapshot.connection !== 'disconnected' || phaseRef.current !== 'in' || rejoining.current) return;
      onDrop(snapshot.endReason);
    });
  }, [connection, onDrop]);

  // Shown fragments arrive as identifier-only references; each is read through its own API.
  useEffect(() => {
    if (phase !== 'in' || !session) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState === 'hidden') return;
      try { await catchUp(session.id, session.projectId, false); } catch { /* next tick */ }
    };
    const timer = window.setInterval(() => { void tick(); }, 2500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [phase, session, catchUp]);

  // Following ends as soon as you go somewhere yourself. A follow or View navigation carries
  // `liveFollow`; a view tidying its own URL (a replace) is not you moving.
  const navigationType = useNavigationType();
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === lastPath.current) return;
    lastPath.current = location.pathname;
    if (navigationType === 'REPLACE' || (location.state as { liveFollow?: boolean } | null)?.liveFollow) return;
    if (followingRef.current) {
      toast({ message: `Stopped following ${names.get(followingRef.current) ?? 'them'}: you moved on your own.` });
      setFollowing(null);
    }
  }, [location.pathname, location.state, navigationType, names, toast]);

  // Deliberate work in the content (typing, dragging, panning) also ends following.
  useEffect(() => {
    if (!following) return;
    const pane = document.getElementById('content');
    if (!pane) return;
    const stop = (event: Event) => {
      if (event instanceof KeyboardEvent && ['Tab', 'Shift', 'Escape'].includes(event.key)) return;
      setFollowing(null);
      toast({ message: `Stopped following ${names.get(following) ?? 'them'}.` });
    };
    pane.addEventListener('pointerdown', stop, { once: true });
    pane.addEventListener('keydown', stop, { once: true });
    return () => { pane.removeEventListener('pointerdown', stop); pane.removeEventListener('keydown', stop); };
  }, [following, names, toast]);

  // An invitation link lands on the anchor with a quiet card: join, later or reply in text.
  // It is taken from the navigation once, because the anchor view may tidy its own URL.
  const invitedBy = (location.state as { liveInvitation?: { sessionId: string; invitationId: string } } | null)?.liveInvitation;
  const [invited, setInvited] = useState<{ sessionId: string; invitationId: string } | null>(null);
  if (invitedBy && invitedBy.invitationId !== invited?.invitationId) setInvited(invitedBy);
  useEffect(() => {
    if (!invited) return;
    let cancelled = false;
    void (async () => {
      const [target, pending] = await Promise.all([getSession(invited.sessionId), pendingInvitations().catch(() => ({ items: [] }))]);
      const row = pending.items.find((item) => item.id === invited.invitationId);
      const label = await anchorLabel(target.projectId, target.context);
      if (cancelled || label === null) return;
      loadPeople(target.projectId);
      if (sessionRef.current?.id === target.id) return;
      setInvitation({
        invitationId: invited.invitationId, sessionId: target.id, projectId: target.projectId,
        inviterId: row?.inviterId ?? target.createdBy, anchor: { projectId: target.projectId, context: target.context, label },
      });
    })().catch(() => { if (!cancelled) toast({ message: 'This invitation is no longer open. The session may have ended.' }); });
    return () => { cancelled = true; };
  }, [invited, loadPeople, toast]);

  const answerInvitation = useCallback(async (choice: 'join' | 'later' | 'text') => {
    const current = invitation;
    if (!current) return;
    if (choice === 'join') {
      try { await join(await getSession(current.sessionId), current.anchor); }
      catch (error) { toast({ message: readable(error), tone: 'danger' }); }
      return;
    }
    try {
      const answer = await replyToInvitation(current.invitationId, choice);
      setInvitation(null);
      if (choice === 'later') { toast({ message: 'Saved for later. It stays in your inbox; nobody was told.' }); return; }
      const where = answer.next.kind === 'open_project_conversation' && answer.next.context.type === 'conversation'
        ? `/projects/${current.projectId}/conversations/${answer.next.context.id}` : anchorPath(current.anchor);
      navigate(where, { state: { focusComposer: true } });
      toast({ message: 'Write your reply in the conversation. Nothing was sent for you.' });
    } catch (error) {
      toast({ message: readable(error), tone: 'danger' });
    }
  }, [invitation, join, navigate, toast]);

  const present = useCallback(async (item: Presentable) => {
    const current = sessionRef.current;
    if (!current || phaseRef.current !== 'in' || item.isCurrent?.() === false) return false;
    try {
      await presentInSession(current.id, item.ref, crypto.randomUUID());
      if (item.isCurrent?.() === false) return false;
      await catchUp(current.id, current.projectId, false).catch(() => undefined);
      toast({ message: `Showing “${item.label}”. Others can open it or follow you; nobody is moved.`, tone: 'success' });
      return true;
    } catch (error) {
      toast({ message: error instanceof ApiError && error.status === 404 ? 'This can’t be shown here: it is not part of this session’s project or changed meanwhile.' : readable(error), tone: 'danger' });
      return false;
    }
  }, [catchUp, toast]);

  const view = useCallback((item: ShownFragment) => {
    if (!item.fragment.path) return;
    navigate(item.fragment.path, { state: { liveSelect: item.fragment.selected ?? null, liveFollow: true } });
    setShown({ ...item, fresh: false });
  }, [navigate]);

  const follow = useCallback((userId: string | null) => {
    setFollowing(userId);
    if (userId && shown && shown.presentation.createdBy === userId && shown.fragment.path) view(shown);
  }, [shown, view]);

  const setQuiet = useCallback((on: boolean) => {
    setQuietState(on);
    const current = connectionRef.current;
    if (!current) return;
    if (on) {
      setFollowing(null);
      void Promise.all((['mic', 'camera', 'screen'] as const).map((kind) => current.setDevice(kind, false)));
      current.setHearing(false);
    } else {
      // Returning resumes listening only; nothing is sent until you turn it on.
      current.setHearing(true);
    }
  }, []);

  const setDevice = useCallback(async (kind: DeviceKind, on: boolean) => {
    const current = connectionRef.current;
    if (!current) return;
    if (on && quietRef.current) { setQuietState(false); current.setHearing(true); }
    await current.setDevice(kind, on);
  }, []);

  const startAudio = useCallback(async () => { await connectionRef.current?.startAudio(); }, []);

  const value = useMemo<LiveValue>(() => ({
    capability, phase, session, anchor, notice, media, quiet, following, shown, invitation, nameOf, fullName, people, meId,
    start, join, leave, setDevice, setQuiet, startAudio, present, view, follow, answerInvitation,
    dismissNotice: () => setNotice(null),
    diagnostics: connection ? connection.diagnostics.bind(connection) : null,
    stage,
    openStage: (focus: string | null = null) => setStage({ open: true, focus }),
    closeStage: () => setStage((current) => ({ ...current, open: false })),
  }), [capability, phase, session, anchor, notice, media, quiet, following, shown, invitation, nameOf, fullName, people, meId,
    start, join, leave, setDevice, setQuiet, startAudio, present, view, follow, answerInvitation, connection, stage]);

  // The registry of what the current views are about.
  const [entries, setEntries] = useState<{ id: number; entry: HereEntry }[]>([]);
  const nextId = useRef(1);
  const register = useCallback((entry: HereEntry) => {
    const id = nextId.current++;
    setEntries((current) => [...current, { id, entry }]);
    return () => setEntries((current) => current.filter((item) => item.id !== id));
  }, []);
  const here = useMemo<Here>(() => {
    // What the person opened most recently wins: a task opened in Details over the page
    // beneath it, and a doc opened afterwards over a task still docked in Details.
    let anchor: LiveAnchor | null = null;
    let presentable: Presentable | null = null;
    for (const { entry } of entries) {
      if (entry.anchor) anchor = entry.anchor;
      if (entry.presentable) presentable = entry.presentable;
    }
    return { anchor, presentable };
  }, [entries]);
  const hereValue = useMemo(() => ({ register, here }), [register, here]);

  return <LiveContext.Provider value={value}><HereContext.Provider value={hereValue}>{children}</HereContext.Provider></LiveContext.Provider>;
}

/**
 * Live sessions running in one project, for the header's quiet "live now" cue. The server
 * rechecks each session's anchor for this reader; presence can be unknown.
 */
export function useProjectSessions(projectId: string | undefined, enabled: boolean): { items: LiveSession[]; refresh(): void } {
  const [loaded, setLoaded] = useState<{ projectId: string; items: LiveSession[] } | null>(null);
  const [tick, setTick] = useState(0);
  const { phase } = useLive();
  useEffect(() => {
    if (!projectId || !enabled) return;
    const controller = new AbortController();
    const load = () => discoverSessions(projectId, controller.signal).then((page) => setLoaded({ projectId, items: page.items }), () => undefined);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 12_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [projectId, enabled, tick, phase]);
  const items = enabled && loaded && loaded.projectId === projectId ? loaded.items : [];
  return { items, refresh: () => setTick((n) => n + 1) };
}

export function sessionAt(items: LiveSession[], anchor: LiveAnchor | null) {
  return anchor ? items.find((item) => sameContext(item.context, anchor.context)) ?? null : null;
}
