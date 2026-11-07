import { useEffect, useRef, useState } from 'react';
import { getAssistantStatus } from '../assistant/api';

/**
 * Whether the person's assistant is ready, read while Search is closed (and again each time it closes), so Search opens with the
 * answer already in hand: its "Ask my assistant…" row is there from the first frame or not at all, and the dialog never grows
 * after it is on screen (#898). A failed read counts as not ready.
 */
export function useAssistantReady(enabled: boolean, open: boolean): boolean {
  const [ready, setReady] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled || open) return;
    getAssistantStatus().then((status) => { if (mounted.current) setReady(status.state === 'ready'); }, () => undefined);
  }, [enabled, open]);
  return ready;
}
