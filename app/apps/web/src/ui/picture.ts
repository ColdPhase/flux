/**
 * What the sidebar's fold (`SizeSwap`) needs to draw the outgoing rendering as a picture: a copy of an element without ids, the scroll
 * positions to give it, the colour it lies on and the page's style sheets for the shadow root that holds it. (The held picture of a
 * view switch is retired: a switch shows the new screen at once, #863.)
 */

export function scrolls(root: HTMLElement): [number, number, number][] {
  const found: [number, number, number][] = [];
  if (root.scrollTop || root.scrollLeft) found.push([-1, root.scrollTop, root.scrollLeft]);
  root.querySelectorAll<HTMLElement>('*').forEach((node, index) => { if (node.scrollTop || node.scrollLeft) found.push([index, node.scrollTop, node.scrollLeft]); });
  return found;
}

/** Puts the scroll positions `scrolls` read from the original into its copy. */
export function restoreScrolls(copy: HTMLElement, list: [number, number, number][]) {
  const nodes = copy.querySelectorAll<HTMLElement>('*');
  for (const [index, top, left] of list) { const target = index < 0 ? copy : nodes[index]; if (target) { target.scrollTop = top; target.scrollLeft = left; } }
}

export function copyOf(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  return copy;
}

/**
 * The ground the content lies on: the first ancestor that paints a colour of its own. The picture wears it, so the old content is a
 * whole picture that fades away over the new, never ink floating over the new content's ink (a double paint).
 */
export function groundOf(node: HTMLElement): string {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return 'transparent';
}

/**
 * The page's own style sheets, as sheets a shadow root can wear (one per sheet). They are rebuilt whenever the sheets or the number of
 * rules in any of them change: a route's styles arrive as a sheet that is listed a moment before its rules can be read.
 * Null where they cannot be shared.
 */
let worn: { signature: string; sheets: CSSStyleSheet[] } | null = null;
export function styles(): CSSStyleSheet[] | null {
  if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function' || !('adoptedStyleSheets' in ShadowRoot.prototype)) return null;
  const sources = [...document.styleSheets];
  const signature = sources.map((source) => { try { return source.cssRules.length; } catch { return -1; } }).join(',');
  if (worn?.signature === signature) return worn.sheets;
  const sheets: CSSStyleSheet[] = [];
  for (const source of sources) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync([...source.cssRules].map((rule) => rule.cssText).join('\n'));
      sheets.push(sheet);
    } catch { /* a sheet the page may not read: the picture goes without it */ }
  }
  worn = { signature, sheets };
  return sheets;
}
