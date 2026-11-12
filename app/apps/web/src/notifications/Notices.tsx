import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import type { InboxItem, StreamEvent } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { anchorPath } from '../live/anchors';
import { getSession } from '../live/api';
import { useLive } from '../live/LiveProvider';
import { Avatar, Button, IconButton, Kreska, MEDIA, duration, settle, useMediaQuery } from '../ui';
import { announceInboxChange, getInboxItem, markInboxRead } from './api';
import './notices.css';

/**
 * In-app notices (#1243; docs/design/final/README.md "Notices", docs/product/mobile-pwa.md "While Flux is open"). The server decides
 * which notifications interrupt a person (their level, quiet hours, mutes) and announces each on the live stream as a
 * `project.notice.v1` or `dm.notice.v1` event whose id is the notification's; this card reads that one item and shows it. It decides
 * only where the person is: nothing for the place on screen, and nothing that arrived while the tab was hidden.
 */

const NOTICE_EVENT = /^(project|dm)\.notice\.v1$/;
/** How long a notice stays (a call's stays until the call ends). */
export const NOTICE_MS = 6000;
/** Older than this when it reaches the tab (it was held while the tab was hidden): the Inbox and push have it, the card does not. */
const STALE_MS = 60_000;
const MESSAGE_REASONS = new Set(['dm', 'mention', 'question', 'reply']);
const LIVE_URL = /^\/projects\/[0-9a-f-]+\/live\/([0-9a-f-]+)/i;

type Family = 'message' | 'call' | 'other';
const callSession = (item: InboxItem) => (item.url ? LIVE_URL.exec(item.url)?.[1] ?? null : null);
const familyOf = (item: InboxItem): Family => callSession(item) ? 'call' : MESSAGE_REASONS.has(item.reason ?? '') ? 'message' : 'other';
const placeOf = (item: InboxItem) => `${item.source.type}:${item.source.id}`;

interface Notice { serial: number; place: string; family: Family; items: InboxItem[] }

/** Whether the place an event is about is the one on screen: its space (any view of it) or its direct message. */
function looksAt(pathname: string, type: string, id: string) {
  return type === 'dm' ? pathname === `/dm/${id}` || pathname.startsWith(`/dm/${id}/`) : pathname === `/projects/${id}` || pathname.startsWith(`/projects/${id}/`);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The title and preview of a notice: the one item's own, or the group's ("3 new messages in Tool library"). */
export function noticeWords(notice: Pick<Notice, 'family' | 'items'>, placeName: (projectId: string) => string | null): { title: string; body: string } {
  const newest = notice.items.at(-1)!;
  const count = notice.items.length;
  if (count === 1) return { title: newest.title, body: newest.body };
  const senders = new Set(notice.items.map((item) => item.from?.name ?? ''));
  const noun = notice.family === 'message' ? 'new messages' : 'updates';
  const where = newest.source.type === 'project' ? ` in ${placeName(newest.source.id) ?? 'a space'}`
    : senders.size === 1 && newest.from ? ` from ${newest.from.name}` : '';
  const body = newest.body && newest.from && senders.size > 1 ? `${firstName(newest.from.name)}: ${newest.body}` : newest.body;
  return { title: `${count} ${noun}${where}`, body };
}

/** Keeps the card 8 px above whatever reaches its corner on a computer: a composer, a toast, the map's dock. */
function useLift(active: boolean, card: React.RefObject<HTMLElement | null>, phone: boolean): number {
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!active || phone) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = card.current?.getBoundingClientRect();
        if (!box) return;
        let bottom = 0;
        for (const node of document.querySelectorAll<HTMLElement>('.composer__box, .ui-toast, [data-notice-avoid]')) {
          const rect = node.getBoundingClientRect();
          if (!rect.height || rect.right <= box.left || rect.left >= box.right || rect.top < window.innerHeight / 2) continue;
          bottom = Math.max(bottom, Math.round(window.innerHeight - rect.top + 8));
        }
        setLift(bottom);
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [active, phone, card]);
  return active && !phone ? lift : 0;
}

/** Whether a dialog or a sheet is open: a notice waits for it to close. */
function useModalOpen(active: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const check = () => setOpen(!!document.querySelector('[aria-modal="true"]'));
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    check();
    return () => observer.disconnect();
  }, [active]);
  return active && open;
}

export function Notices({ identity, placeName }: { identity: string; placeName: (projectId: string) => string | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const live = useLive();
  const phone = useMediaQuery(MEDIA.phone);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState({ hover: false, focus: false });
  const serial = useRef(0);
  const here = useRef(location.pathname);
  useEffect(() => { here.current = location.pathname; }, [location.pathname]);
  const card = useRef<HTMLDivElement>(null);
  const shown = useRef<Notice | null>(null);
  useEffect(() => { shown.current = leaving ? null : notice; }, [notice, leaving]);

  const leavingNow = useRef(false);
  useEffect(() => { leavingNow.current = leaving; }, [leaving]);
  const entered = useRef<number | null>(null);

  const add = useCallback((item: InboxItem) => {
    const family = familyOf(item);
    const place = placeOf(item);
    // A notice that arrives while the last one leaves enters again from where that one is.
    if (leavingNow.current) entered.current = null;
    setLeaving(false);
    setNotice((current) => {
      const live = current && shown.current === current ? current : null;
      // A call stays until it ends or is closed; only another call takes its place (the rest is in the Inbox).
      if (live?.family === 'call' && family !== 'call') return current;
      if (live && family !== 'call' && live.family === family && live.place === place && !live.items.some((known) => known.id === item.id)) {
        return { ...live, items: [...live.items, item].slice(-99) };
      }
      return { serial: ++serial.current, place, family, items: [item] };
    });
  }, []);

  const dismiss = useCallback(() => setLeaving(true), []);

  useStreamEvents(identity, (event: StreamEvent) => {
    if (NOTICE_EVENT.test(event.kind)) {
      if (Date.now() - Date.parse(event.createdAt) > STALE_MS) return;
      if (looksAt(here.current, event.objectType, event.objectId)) return;
      void getInboxItem(event.id).then((item) => {
        if (item.readAt || looksAt(here.current, item.source.type, item.source.id)) return;
        add(item);
      }, () => undefined);
      return;
    }
    // A call notice leaves when its call ends.
    const current = shown.current;
    const session = current?.family === 'call' ? callSession(current.items.at(-1)!) : null;
    if (session && event.kind === 'project.live_changed.v1' && current!.items.at(-1)!.source.id === event.objectId) {
      void getSession(session).then((state) => { if (state.state === 'ended' || state.state === 'ending') dismiss(); }, () => dismiss());
    }
  });

  // Going to the place a notice is about answers it.
  useEffect(() => {
    const current = shown.current;
    const newest = current?.items.at(-1);
    if (newest && looksAt(location.pathname, newest.source.type, newest.source.id)) dismiss();
  }, [location.pathname, dismiss]);

  const modal = useModalOpen(!!notice);
  const visible = !!notice && !modal;
  const lift = useLift(visible, card, phone);

  // Enters once per notice; a newer one that replaces or joins it changes the text in place (docs/design/motion.md).
  useLayoutEffect(() => {
    if (!visible || leaving) { if (!visible) entered.current = null; return; }
    if (entered.current !== null) return;
    entered.current = notice!.serial;
    void settle(card.current, { opacity: 1, transform: 'none' }, duration('--dur-in'), '--ease-out',
      { from: { opacity: 0, transform: `translateY(${phone ? -8 : 8}px)` } });
  }, [visible, leaving, notice, phone]);

  useEffect(() => {
    if (!leaving) return;
    let gone = false;
    void settle(card.current, { opacity: 0, transform: `translateY(${phone ? -8 : 8}px)` }, duration('--dur-out'), '--ease-in', { from: { opacity: 1, transform: 'none' }, fill: 'forwards' })
      .then(() => { if (!gone) { setNotice(null); setLeaving(false); setHeld({ hover: false, focus: false }); entered.current = null; } });
    return () => { gone = true; };
  }, [leaving, phone]);

  // About 6 s, paused while hovered or focused or while a dialog holds it; a call's stays.
  const timed = visible && !leaving && notice!.family !== 'call' && !held.hover && !held.focus;
  const count = notice?.items.length ?? 0;
  useEffect(() => {
    if (!timed) return undefined;
    const timer = window.setTimeout(dismiss, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [timed, dismiss, notice?.serial, count]);

  const readAll = useCallback((items: InboxItem[]) => {
    for (const item of items.slice(0, -1)) void markInboxRead(item.id).then(announceInboxChange, () => undefined);
  }, []);
  const open = useCallback((focusComposer = false) => {
    if (!notice) return;
    const newest = notice.items.at(-1)!;
    readAll(notice.items);
    dismiss();
    // `/inbox/:id` reads the item and goes where it points, as a push's tap does; the state reaches the place (Reply focuses its composer).
    navigate(`/inbox/${newest.id}`, focusComposer ? { state: { focusComposer: true } } : undefined);
  }, [notice, readAll, dismiss, navigate]);
  const join = useCallback(async () => {
    if (!notice) return;
    const newest = notice.items.at(-1)!;
    const id = callSession(newest);
    dismiss();
    void markInboxRead(newest.id).then(announceInboxChange, () => undefined);
    if (!id) return;
    try {
      const session = await getSession(id);
      if (session.state === 'ended' || session.state === 'ending') { navigate(`/inbox/${newest.id}`); return; }
      navigate(anchorPath(session));
      await live.join(session);
    } catch {
      navigate(`/inbox/${newest.id}`);
    }
  }, [notice, dismiss, navigate, live]);

  const newest = notice?.items.at(-1) ?? null;
  const words = notice ? noticeWords(notice, placeName) : null;
  return createPortal(
    <div className="ui-notices" role="status" aria-live="polite" aria-atomic="true"
      style={lift ? { '--notice-lift': `${lift}px` } as CSSProperties : undefined}>
      {visible && newest && words ? (
        <div ref={card} className="ui-notice" data-family={notice!.family} data-count={notice!.items.length}
          onMouseEnter={() => setHeld((value) => ({ ...value, hover: true }))} onMouseLeave={() => setHeld((value) => ({ ...value, hover: false }))}
          onFocus={() => setHeld((value) => ({ ...value, focus: true }))}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld((value) => ({ ...value, focus: false })); }}>
          <span className="ui-notice__face" aria-hidden="true">
            {newest.from?.kind === 'agent' || (!newest.from && newest.reason === 'approval') ? <Kreska size={32} /> : <Avatar name={newest.from?.name ?? ''} size="lg" />}
          </span>
          <div className="ui-notice__text">
            <p className="ui-notice__title">{words.title}</p>
            {words.body ? <p className="ui-notice__body">{words.body}</p> : null}
          </div>
          <IconButton icon="x" label="Close" className="ui-notice__close" onClick={dismiss} />
          <div className="ui-notice__actions">
            {notice!.family === 'call' ? <Button variant="primary" onClick={() => void join()}>Join</Button>
              : newest.reason === 'dm' ? <><Button variant="outline" onClick={() => open(true)}>Reply</Button><Button variant="secondary" onClick={() => open()}>Open</Button></>
                : <Button variant="outline" onClick={() => open()}>Open</Button>}
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
