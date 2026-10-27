import { useEffect, useState } from 'react';
import { duration, motionAllowed } from './motion';

/**
 * A menu or popover that leaves as it came (#593 AC-1). It stays mounted for the exit (--dur-out, 120 ms), marked
 * `inert` so nothing in it can be reached, focused or heard while it fades; its key handlers and focus belong to the
 * caller, which returns focus at once when it closes. Spread `props` on the surface:
 *
 *     const pop = usePop(open);
 *     {pop.mounted ? <div {...pop.props} role="menu">…</div> : null}
 *
 * The motion is CSS (`[data-pop]` in ui.css), so reduced motion gives the static end state with no timer: a closed
 * menu is gone at once. `from` is the side it opens from (`above` for a menu over its button), `fade` is for a
 * surface a script positions with its own transform: it only fades.
 */
export function usePop(open: boolean, options: { from?: 'below' | 'above'; fade?: boolean } = {}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const exiting = !open && mounted;
  // With motion off (reduced motion, a hidden page) a closed surface is gone in the same render.
  const animated = exiting && duration('--dur-out') > 0 && motionAllowed();
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => setMounted(false), animated ? duration('--dur-out') + 40 : 0);
    return () => window.clearTimeout(timer);
  }, [exiting, animated]);
  return {
    mounted: open || animated,
    props: {
      'data-pop': open ? 'open' : 'closing',
      'data-pop-from': options.from ?? 'below',
      'data-pop-fade': options.fade ? '' : undefined,
      inert: !open,
    },
  } as const;
}
