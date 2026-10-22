import { Component, type ReactNode, type RefObject } from 'react';
import { MOTION_ID, duration, motionAllowed, token, track, travelDirection, type DurationToken, type TravelDirection } from './motion';

/**
 * What was shown dissolves into what replaces it (#593 AC-2, AC-3): the detail panel's content and the content area of a view or
 * place. The new content is put in one commit, in place, live from the first frame; this keeps the outgoing content on screen as an
 * inert picture of itself and fades it away over the new (opacity, and a few pixels of travel towards where the person came from).
 * So there is never a blank cut, the old content is retained for the length of the exit, and what must not move (the panel's shell,
 * head and controls; the header, sidebar and tab bar; the new content itself) does not. Reduced motion, a hidden page and the first
 * screen simply swap.
 *
 * It renders its children and nothing else: it is a class only because React offers the moment before the swap (what the
 * outgoing content looks like) to class components alone, in `getSnapshotBeforeUpdate`.
 *
 * The picture is a deep copy without ids, `inert`, `aria-hidden`, taking no pointer input, and it is not part of the page's own
 * tree. It lies over the host in a layer of its own at the end of `body`, inside a closed shadow root that wears the page's style
 * sheets, so no query of the page (a class selector, a text, a role, `#details .wd-eyebrow`) can find a second copy of what is on
 * show: the picture is only a picture. It is dressed in empty copies of the host's own ancestors up to `dress` (`display:
 * contents`, so they have no box of their own), so the selectors that read those classes (`.ui-panel__body > .x`, `.app__pane .x`)
 * style it as they styled the original. Scroll positions inside it are copied, so the old content does not jump. (The page's own
 * `:root[...]` rules do not reach into it; they are a few shadows and fills that differ for the length of a fade.)
 */
interface Props {
  /** What the content is: when it changes, the old content dissolves. */
  id: string;
  /** How many steps of "‹ back" lie behind the content (a panel); a lower number than before is back. */
  depth?: number;
  /** Which way the person is going, when there is no depth to say (a view). */
  direction?: TravelDirection;
  /** The element whose children are the content: the picture lies over it. */
  host: RefObject<HTMLElement | null>;
  /** The topmost ancestor the picture is dressed in (a selector the host is inside: the panel, the app). */
  dress: string;
  /** How far the old content travels while it leaves, and how long it takes. */
  shift: '--shift-panel' | '--shift-view';
  time: DurationToken;
  /** The layer the picture is on; by default one above the layer the host is in. */
  layer?: number;
  /** Children of the host that are not content (they stay out of the picture). */
  skip?: string;
  children: ReactNode;
}

interface Piece { copy: HTMLElement; top: number; left: number; width: number; height: number; scrolls: [number, number, number][] }
interface Snapshot { pieces: Piece[]; direction: TravelDirection; from: string; scrollTop: number; scrollLeft: number }

const MARK = 'data-dissolve';

function scrolls(root: HTMLElement): [number, number, number][] {
  const found: [number, number, number][] = [];
  if (root.scrollTop || root.scrollLeft) found.push([-1, root.scrollTop, root.scrollLeft]);
  root.querySelectorAll<HTMLElement>('*').forEach((node, index) => { if (node.scrollTop || node.scrollLeft) found.push([index, node.scrollTop, node.scrollLeft]); });
  return found;
}

function copyOf(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  return copy;
}

/** One above the nearest layer the host sits in (the docked panel's, an overlay's), so the picture lies over it and under what opens above. */
function above(node: HTMLElement): number {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const layer = parseInt(getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(layer)) return layer + 1;
  }
  return 1;
}

/** The page's own style sheets, as sheets a shadow root can wear (one per sheet, rebuilt when a route's styles arrive). Null where they cannot be shared. */
let worn: { count: number; sheets: CSSStyleSheet[] } | null = null;
function styles(): CSSStyleSheet[] | null {
  if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function' || !('adoptedStyleSheets' in ShadowRoot.prototype)) return null;
  const sources = [...document.styleSheets];
  if (worn?.count === sources.length) return worn.sheets;
  const sheets: CSSStyleSheet[] = [];
  for (const source of sources) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync([...source.cssRules].map((rule) => rule.cssText).join('\n'));
      sheets.push(sheet);
    } catch { /* a sheet the page may not read: the picture goes without it */ }
  }
  worn = { count: sources.length, sheets };
  return sheets;
}

export class Dissolve extends Component<Props, Record<string, never>, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { id, depth = 0, direction, host, time, skip } = this.props;
    const body = host.current;
    if (previous.id === id || !body || !motionAllowed() || !duration(time) || !styles()) return null;
    const way: TravelDirection = this.props.depth !== undefined ? (depth > (previous.depth ?? 0) ? 'forward' : depth < (previous.depth ?? 0) ? 'back' : travelDirection()) : direction ?? travelDirection();
    const pieces = [...body.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !(skip && child.matches(skip)) && child.offsetWidth > 0 && child.offsetHeight > 0)
      .map((source) => ({ copy: copyOf(source), top: source.offsetTop, left: source.offsetLeft, width: source.offsetWidth, height: source.offsetHeight, scrolls: scrolls(source) }));
    return pieces.length ? { pieces, direction: way, from: previous.id, scrollTop: body.scrollTop, scrollLeft: body.scrollLeft } : null;
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    const { host, dress, shift: shiftToken, time, layer: given } = this.props;
    const body = host.current;
    const ms = duration(time);
    const sheets = styles();
    if (!snapshot || !body || !ms || !sheets) return;
    const shift = parseFloat(token(shiftToken)) || 16;
    // The copy leaves the way the person came from: forward, it goes towards where they were; back, the other way.
    const travel = (snapshot.direction === 'back' ? 1 : -1) * shift;
    const box = body.getBoundingClientRect();
    const frame = document.createElement('div');
    frame.setAttribute(MARK, snapshot.from);
    frame.setAttribute('inert', '');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', left: `${box.left + body.clientLeft}px`, top: `${box.top + body.clientTop}px`, width: `${body.clientWidth}px`, height: `${body.clientHeight}px`,
      overflow: 'hidden', pointerEvents: 'none', zIndex: String(given ?? above(body)) });
    const root = frame.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = sheets;
    // The host's own ancestors, empty and without a box of their own, so the copy is styled by the same selectors as the original.
    let parent: Node = root;
    const ancestors: HTMLElement[] = [];
    for (let node: HTMLElement | null = body; node; node = node.parentElement) { ancestors.unshift(node); if (node.matches(dress)) break; }
    for (const ancestor of ancestors) {
      const copy = document.createElement(ancestor.tagName);
      copy.className = ancestor.className;
      for (const [key, value] of Object.entries(ancestor.dataset)) copy.dataset[key] = value;
      copy.style.display = 'contents';
      parent.appendChild(copy);
      parent = copy;
    }
    const gone: Promise<unknown>[] = [];
    for (const piece of snapshot.pieces) {
      const copy = piece.copy;
      copy.setAttribute('inert', '');
      copy.setAttribute('aria-hidden', 'true');
      Object.assign(copy.style, { position: 'absolute', top: `${piece.top - snapshot.scrollTop}px`, left: `${piece.left - snapshot.scrollLeft}px`, width: `${piece.width}px`, height: `${piece.height}px`, margin: '0', pointerEvents: 'none' });
      parent.appendChild(copy);
      const nodes = copy.querySelectorAll<HTMLElement>('*');
      for (const [index, top, left] of piece.scrolls) { const target = index < 0 ? copy : nodes[index]; if (target) { target.scrollTop = top; target.scrollLeft = left; } }
      const leave = copy.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${travel}px)` }], { duration: ms, easing: token('--ease-in') || 'ease-in', fill: 'forwards' });
      leave.id = MOTION_ID;
      track(leave);
      gone.push(leave.finished.catch(() => undefined));
    }
    document.body.appendChild(frame);
    void Promise.all(gone).then(() => frame.remove());
  }

  render() { return this.props.children; }
}
