import { useEffect, useRef } from 'react';
import { useLiveRun } from './liveRun';

/**
 * Brings what arrives at the end of a feed into view (a private answer, the working line, the answer that replaces it), unless the person has
 * scrolled up to read: then it waits at the end and the feed does not move under them (#842). `key` changes when something arrives.
 * `growing`: the run whose answer is being written (#1248): while the reader is at the end, the feed follows its words as they grow, so the
 * newest words and Stop stay in view.
 */
export function useFollowEnd(feed: () => HTMLElement | null, key: string, growing: string | null = null) {
  const words = useLiveRun(growing).text.length;
  const find = useRef(feed);
  useEffect(() => { find.current = feed; });
  const near = useRef(true);
  useEffect(() => {
    const onScroll = (event: Event) => {
      const el = find.current();
      if (el && event.target === el) near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);
  useEffect(() => {
    if ((!key && !words) || !near.current) return undefined;
    const frame = requestAnimationFrame(() => { const el = find.current(); if (el) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [key, words]);
}
