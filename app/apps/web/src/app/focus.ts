import { useCallback, useEffect, useRef, useState } from 'react';
import { PAUSE_CHANGED, announcePauseChange, announcePauseUncertainty, getPreferences, updatePreferences, type PauseChange } from '../notifications/api';
import { beginNotificationSession, captureNotificationSession, isCurrentNotificationSession, notificationPauseRevision, notificationPauseUncertain, retireNotificationSession, type NotificationSession } from '../notifications/session';
import { useToast } from '../ui';

const MIN_FOCUS_MS = 30 * 60_000;

/** A new focus lasts to the first full hour at least 30 minutes away: 11:20 → 12:00, 11:40 → 13:00. */
export function focusEnd(now = new Date()) {
  const at = new Date(now.getTime() + MIN_FOCUS_MS);
  if (at.getMinutes() || at.getSeconds() || at.getMilliseconds()) at.setHours(at.getHours() + 1, 0, 0, 0);
  return at;
}

export const clock = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Focus mode (F-026 S19, `F`): the server holds push and email until the pause ends, so the words
 * "notifications paused" are true on every device. It ends at its time or when turned off; the
 * pause is read again whenever the window regains focus, so another device's change shows here.
 */
export function useFocus(identity: string) {
  const toast = useToast();
  // The pause belongs to the identity that read it; another identity never sees it.
  const [state, setState] = useState<{ owner: string; until: Date | null; expired: boolean; uncertain: boolean }>({ owner: identity, until: null, expired: false, uncertain: false });
  const knownUntil = state.owner === identity ? state.until : null;
  const until = knownUntil && !state.expired ? knownUntil : null;
  const uncertain = state.owner === identity && state.uncertain;
  const busy = useRef<NotificationSession | null>(null);
  const who = useRef(identity);
  const readNotice = useRef<(() => void) | null>(null);
  const clearReadNotice = useCallback(() => { readNotice.current?.(); readNotice.current = null; }, []);
  // Every applied state is numbered. A read applies only if nothing newer (a confirmed change,
  // another read's answer or a new identity) has been applied since it was asked for.
  const version = useRef(0);
  const apply = useCallback((pause: string | null, unverified = false) => {
    version.current += 1;
    const at = pause ? new Date(pause) : null;
    setState({ owner: who.current, until: at, expired: at !== null && at.getTime() <= Date.now(), uncertain: unverified });
  }, []);
  const refresh = useCallback(() => {
    const mine = version.current;
    const session = captureNotificationSession(who.current);
    if (!session) return;
    void getPreferences().then((prefs) => {
      if (mine === version.current && isCurrentNotificationSession(session)) announcePauseChange(session.ownerId, prefs.pause.until);
    }, () => {
      if (mine === version.current && isCurrentNotificationSession(session)) {
        announcePauseUncertainty(session, 'Current notification pause could not be checked. Try again.');
      }
    });
  }, []);
  useEffect(() => {
    who.current = identity;
    const session = beginNotificationSession(identity);
    version.current += 1;
    refresh();
    return () => { retireNotificationSession(session); version.current += 1; clearReadNotice(); };
  }, [refresh, identity, clearReadNotice]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  // A change confirmed elsewhere in this tab (Notification settings) shows here at once.
  useEffect(() => {
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<PauseChange>).detail;
      if (change.ownerId === who.current && isCurrentNotificationSession(captureNotificationSession(who.current))) {
        if (!change.uncertain) clearReadNotice();
        else if (change.notice) { clearReadNotice(); readNotice.current = toast({ message: change.notice, tone: 'danger' }); }
        apply(change.until, change.uncertain);
      }
    };
    window.addEventListener(PAUSE_CHANGED, onChange);
    return () => window.removeEventListener(PAUSE_CHANGED, onChange);
  }, [apply, clearReadNotice, toast]);
  // Another device can extend the pause without a focus event. Read at the old deadline before
  // confirming Resume; a failed read expires only the old presentation and retains uncertainty.
  useEffect(() => {
    if (!knownUntil || (uncertain && knownUntil.getTime() <= Date.now())) return undefined;
    const mine = version.current;
    const session = captureNotificationSession(who.current);
    const timer = window.setTimeout(() => {
      if (mine === version.current && isCurrentNotificationSession(session)) refresh();
    }, Math.max(0, knownUntil.getTime() - Date.now()));
    return () => window.clearTimeout(timer);
  }, [knownUntil, uncertain, refresh]);

  const toggle = useCallback(async () => {
    const session = captureNotificationSession(who.current);
    if (!session || busy.current === session) return;
    // With current state unavailable, F/Retry reads rather than guessing which mutation is wanted.
    if (notificationPauseUncertain(session)) { refresh(); return; }
    busy.current = session;
    // Focus shows only once the server holds notifications, so "paused" is never claimed early.
    const next = until ? null : focusEnd();
    const owner = who.current;
    const pauseVersion = notificationPauseRevision(session);
    try {
      let prefs: Awaited<ReturnType<typeof updatePreferences>>;
      try { prefs = await updatePreferences({ pause: { until: next ? next.toISOString() : null } }); }
      catch {
        if (isCurrentNotificationSession(session)) toast({ message: next ? 'Focus did not start: notifications are not paused' : 'Focus did not end; try again', tone: 'danger' });
        return;
      }
      // The confirmed change is the newest state and drops any read still in flight; only a
      // different signed-in identity makes it obsolete.
      if (owner === who.current && isCurrentNotificationSession(session)) {
        if (notificationPauseRevision(session) !== pauseVersion || notificationPauseUncertain(session)) {
          // Another surface confirmed a change while this response was in flight. Read the
          // actual current state instead of briefly showing the superseded action snapshot.
          const mine = version.current;
          try {
            const current = await getPreferences();
            if (mine === version.current && isCurrentNotificationSession(session)) announcePauseChange(owner, current.pause.until);
          } catch {
            if (mine === version.current && isCurrentNotificationSession(session)) {
              announcePauseUncertainty(session, 'Focus change saved, but the current notification pause could not be checked. The last confirmed state is shown.');
            }
          }
        } else announcePauseChange(owner, prefs.pause.until);
      }
    } finally {
      if (busy.current === session) busy.current = null;
    }
  }, [until, toast, refresh]);

  return { until, uncertain, toggle, refresh };
}
