import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { duration, settle } from './motion';

/**
 * A view switch (#863, docs/design/motion.md rule 2): switching a space's view or going to another place puts the new screen
 * in place at once. It may fade in over `--dur-1` on `--ease-out`; the old view is never held and never crossfades with the
 * new one, and nothing travels. A screen whose content is still loading shows its own loading state in its final layout.
 *
 * It renders its children and nothing else. When `id` (what the content is) changes after the first screen, the children of
 * `host` fade in, except those matching `skip` (a surface that stays, like the live stage). Reduced motion, a hidden page and
 * the first screen simply swap.
 */
export function ViewFade({ id, host, skip, children }: { id: string; host: RefObject<HTMLElement | null>; skip?: string; children: ReactNode }) {
  const shown = useRef(id);
  useLayoutEffect(() => {
    if (shown.current === id) return;
    shown.current = id;
    const ms = duration('--dur-1');
    if (!ms) return;
    for (const child of host.current?.children ?? []) {
      if (skip && child.matches(skip)) continue;
      void settle(child, { opacity: 1 }, ms, '--ease-out', { from: { opacity: 0 } });
    }
  }, [id, host, skip]);
  return children;
}
