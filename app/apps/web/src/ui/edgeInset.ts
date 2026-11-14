/**
 * Publishes how far a floating control's top edge stands above the bottom of the window, as a CSS length on the
 * root. Body portals (the toast) take their place from the control that is really there, so a safe area, a larger
 * text size, a wrapped label or the engine's layout rounding can never leave them overlapping it or guessing its size.
 * When the control is not in the visible viewport (hidden while typing, or an on-screen keyboard), the bottom of the
 * visible viewport is published instead. Returns the cleanup: it stops measuring and removes the property.
 *
 * `also` are elements whose size moves the control without resizing it, such as the dock it hangs from. A hidden probe as
 * tall as the bottom safe area is observed too: that inset can change (a phone turning, the home indicator) without the
 * control, its dock or the window resizing at that moment, and the control then stands somewhere else.
 */
export function publishTopEdge(node: HTMLElement, property: string, also: readonly Element[] = []): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const update = () => {
    const bottom = Math.min(window.innerHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
    const rect = node.getBoundingClientRect();
    const edge = rect.width && rect.height && rect.top < bottom && rect.bottom > 0 ? rect.top : bottom;
    root.style.setProperty(property, `${Math.max(0, window.innerHeight - edge)}px`);
  };
  const safeArea = document.createElement('div');
  safeArea.setAttribute('aria-hidden', 'true');
  safeArea.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
  document.body.append(safeArea);
  const observer = new ResizeObserver(update);
  observer.observe(node, { box: 'border-box' });
  observer.observe(safeArea);
  for (const element of also) observer.observe(element);
  window.addEventListener('resize', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  update();
  return () => {
    observer.disconnect();
    safeArea.remove();
    window.removeEventListener('resize', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    root.style.removeProperty(property);
  };
}

const shared = new Map<string, { nodes: Set<Element>; observer: ResizeObserver; update: () => void; stop: () => void }>();

/**
 * Like `publishTopEdge` for a control there can be several of at once (the composers of a conversation and its thread): the property is the
 * highest top edge of those drawn inside the visible viewport, and is absent while none is. A toast lifts above it (#1424), so it never
 * stands on a composer's hint. Returns the cleanup for this node; the last one out stops measuring.
 */
export function publishHighestTopEdge(node: Element, property: string): () => void {
  let group = shared.get(property);
  if (!group) {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const nodes = new Set<Element>();
    const update = () => {
      const bottom = Math.min(window.innerHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
      let edge = Infinity;
      for (const item of nodes) {
        const rect = item.getBoundingClientRect();
        if (rect.width && rect.height && rect.top < bottom && rect.bottom > 0) edge = Math.min(edge, rect.top);
      }
      if (Number.isFinite(edge)) root.style.setProperty(property, `${Math.max(0, window.innerHeight - edge)}px`); else root.style.removeProperty(property);
    };
    const observer = new ResizeObserver(update);
    // A view that slides or fades in settles after it is measured: measure again when any motion ends, once per frame.
    let frame = 0;
    const settled = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    window.addEventListener('resize', update);
    window.addEventListener('animationend', settled, true);
    window.addEventListener('transitionend', settled, true);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    const stop = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('animationend', settled, true);
      window.removeEventListener('transitionend', settled, true);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      root.style.removeProperty(property);
      shared.delete(property);
    };
    group = { nodes, observer, update, stop };
    shared.set(property, group);
  }
  group.nodes.add(node);
  group.observer.observe(node, { box: 'border-box' });
  group.update();
  const mine = group;
  return () => {
    mine.nodes.delete(node);
    mine.observer.unobserve(node);
    if (mine.nodes.size) mine.update(); else mine.stop();
  };
}
