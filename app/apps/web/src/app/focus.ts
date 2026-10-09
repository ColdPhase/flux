import { useCallback, useEffect, useRef, useState } from 'react';
import { PAUSE_CHANGED, getPreferences, updatePreferences } from '../notifications/api';
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
  const [state, setState] = useState<{ owner: string; until: Date | null }>({ owner: identity, until: null });
  const until = state.owner === identity ? state.until : null;
  const busy = useRef(false);
  const who = useRef(identity);
  // Every applied state is numbered. A read applies only if nothing newer (a confirmed change,
  // another read's answer or a new identity) has been applied since it was asked for.
  const version = useRef(0);
  const apply = useCallback((pause: string | null) => {
    version.current += 1;
    setState({ owner: who.current, until: pause ? new Date(pause) : null });
  }, []);
  const refresh = useCallback(() => {
    const mine = version.current;
    void getPreferences().then((prefs) => { if (mine === version.current) apply(prefs.pause.until); }, () => undefined);
  }, [apply]);
  useEffect(() => {
    who.current = identity;
    version.current += 1;
    refresh();
  }, [refresh, identity]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  // A change confirmed elsewhere in this tab (Notification settings) shows here at once.
  useEffect(() => {
    const onChange = (event: Event) => apply((event as CustomEvent<string | null>).detail);
    window.addEventListener(PAUSE_CHANGED, onChange);
    return () => window.removeEventListener(PAUSE_CHANGED, onChange);
  }, [apply]);
  // A pause ends on its own at its time; nothing claims it is still running after that.
  useEffect(() => {
    if (!until) return undefined;
    const timer = window.setTimeout(() => setState((current) => ({ ...current, until: null })), Math.max(0, until.getTime() - Date.now()));
    return () => window.clearTimeout(timer);
  }, [until]);

  const toggle = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    // Focus shows only once the server holds notifications, so "paused" is never claimed early.
    const next = until ? null : focusEnd();
    const owner = who.current;
    try {
      const prefs = await updatePreferences({ pause: { until: next ? next.toISOString() : null } });
      // The confirmed change is the newest state and drops any read still in flight; only a
      // different signed-in identity makes it obsolete.
      if (owner === who.current) apply(prefs.pause.until);
    } catch {
      toast({ message: next ? 'Focus did not start: notifications are not paused' : 'Focus did not end; try again', tone: 'danger' });
    } finally {
      busy.current = false;
    }
  }, [until, toast, apply]);

  return { until, toggle };
}
