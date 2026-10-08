import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreferences, updatePreferences } from '../notifications/api';
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
  const [until, setUntil] = useState<Date | null>(null);
  const busy = useRef(false);
  const refresh = useCallback(() => {
    void getPreferences().then((prefs) => setUntil(prefs.pause.until ? new Date(prefs.pause.until) : null), () => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh, identity]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  // A pause ends on its own at its time; nothing claims it is still running after that.
  useEffect(() => {
    if (!until) return undefined;
    const timer = window.setTimeout(() => setUntil(null), Math.max(0, until.getTime() - Date.now()));
    return () => window.clearTimeout(timer);
  }, [until]);

  const toggle = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    // Focus shows only once the server holds notifications, so "paused" is never claimed early.
    const next = until ? null : focusEnd();
    try {
      const prefs = await updatePreferences({ pause: { until: next ? next.toISOString() : null } });
      setUntil(prefs.pause.until ? new Date(prefs.pause.until) : null);
    } catch {
      toast({ message: next ? 'Focus did not start: notifications are not paused' : 'Focus did not end; try again', tone: 'danger' });
    } finally {
      busy.current = false;
    }
  }, [until, toast]);

  return { until, toggle };
}
