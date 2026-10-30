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
 * The picture is a whole picture: it wears the ground the content lay on (the first painted background above the host, in whatever theme
 * is on), so while it fades the new content is revealed through it as old-to-new, never old ink over new ink. It fades only once the
 * new content has painted and is not still waiting on its own first reads (`UNSETTLED`, bounded by `HOLD_MS`); until then it stands as
 * the old content did, so there is never a frame of only the ground or of a view that has not painted. (#719)
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

interface Piece { copy: HTMLElement; top: number; left: number; width: number; height: number; scrolls: [HTMLElement, number, number][] }
interface Snapshot { pieces: Piece[]; direction: TravelDirection; from: string; scrollTop: number; scrollLeft: number; keep?: boolean; replaces?: Picture }
/** The picture that is on show for this host: how much of it is left, what it takes to make it wait for the content that is there now, and to end it. */
interface Picture { frame: HTMLElement; opacity: () => number; rearm: () => void; dismiss: () => void }

const MARK = 'data-dissolve';
/** Content that has not painted what it will show: a stream held back until its first reads have settled, a list that is loading. */
const UNSETTLED = '[aria-busy="true"]:not(button, a, [role="button"], [role="menuitem"]), .is-opening';
/**
 * How long the old content is held at full strength for the new to settle (it never delays the new content, which is live
 * underneath): by then a view has either painted or is showing its own loading moment, and the old content goes.
 */
const HOLD_MS = 500;
/**
 * A picture that is replaced while it is still on show: from this much of it left it stays (it goes back to full strength, a rise of at
 * most this much, and holds for the newest content); with less left the settled view behind it is what is on screen, and that view
 * becomes the picture (a rise of the old one's opacity, at most this much, and the new content is never seen unsettled).
 */
const KEEP_AT = 0.5;

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

/** A list with at least this many children keeps only the ones near the viewport in the picture. */
const LONG_LIST = 8;
/** A child shorter than this is cheaper to copy than to stand in for. */
const STAND_IN_FROM = 48;

/**
 * The picture of one piece of the old content, and the scroll positions to give its copies. What is within a viewport's height of the
 * viewport is copied whole; the children of a long list (a screenful of messages, tasks or rows) that lie wholly beyond that are
 * stood in for by an empty box of the same height, so the picture's layout is the old content's and the rows that can be seen are
 * the same rows, while the browser styles and lays out a few dozen nodes instead of thousands on every view change (#716). The
 * boxes are measured before anything has changed, so the reads cost nothing.
 */
function pictureOf(source: HTMLElement, view: DOMRect): { copy: HTMLElement; scrolls: [HTMLElement, number, number][] } {
  const found: [HTMLElement, number, number][] = [];
  const above = view.top - view.height;
  const below = view.bottom + view.height;
  const copyNode = (node: HTMLElement): HTMLElement => {
    const copy = node.cloneNode(false) as HTMLElement;
    copy.removeAttribute('id');
    if (node.scrollTop || node.scrollLeft) found.push([copy, node.scrollTop, node.scrollLeft]);
    const long = node.childElementCount >= LONG_LIST;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (!(child instanceof HTMLElement)) {
        const other = child.cloneNode(true);
        if (other instanceof Element) { other.removeAttribute('id'); other.querySelectorAll('[id]').forEach((inner) => inner.removeAttribute('id')); }
        copy.appendChild(other);
        continue;
      }
      if (long) {
        const box = child.getBoundingClientRect();
        if (box.height >= STAND_IN_FROM && (box.bottom < above || box.top > below)) {
          const stand = child.cloneNode(false) as HTMLElement;
          stand.removeAttribute('id');
          Object.assign(stand.style, { height: `${box.height}px`, minHeight: '0', maxHeight: 'none', flex: 'none', overflow: 'hidden', boxSizing: 'border-box' });
          copy.appendChild(stand);
          continue;
        }
      }
      copy.appendChild(copyNode(child));
    }
    return copy;
  };
  return { copy: copyNode(source), scrolls: found };
}

/** One above the nearest layer the host sits in (the docked panel's, an overlay's), so the picture lies over it and under what opens above. */
function above(node: HTMLElement): number {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const layer = parseInt(getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(layer)) return layer + 1;
  }
  return 1;
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

export class Dissolve extends Component<Props, Record<string, never>, Snapshot | null> {
  private picture: Picture | null = null;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { id, depth = 0, direction, host, time, skip } = this.props;
    const body = host.current;
    if (previous.id === id || !body || !motionAllowed() || !duration(time) || !styles()) return null;
    // Replaced again while the picture of an earlier replacement is still on show (held or fading): with most of it left it stays what
    // it is, the picture of the first old content, and waits for this newest content (the view in between, or one that has not settled,
    // is never taken as a picture of its own). With little of it left (the fade was nearly over) what is on screen is the view behind it,
    // which settled before the fade began: that view, not the nearly gone picture, is what the new picture is of.
    let replaces: Picture | undefined;
    if (this.picture?.frame.isConnected) {
      if (this.picture.opacity() >= KEEP_AT) return { pieces: [], direction: 'forward', from: previous.id, scrollTop: 0, scrollLeft: 0, keep: true };
      replaces = this.picture;
    }
    const way: TravelDirection = this.props.depth !== undefined ? (depth > (previous.depth ?? 0) ? 'forward' : depth < (previous.depth ?? 0) ? 'back' : travelDirection()) : direction ?? travelDirection();
    const view = body.getBoundingClientRect();
    const pieces = [...body.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !(skip && child.matches(skip)) && child.offsetWidth > 0 && child.offsetHeight > 0)
      .map((source) => ({ ...pictureOf(source, view), top: source.offsetTop, left: source.offsetLeft, width: source.offsetWidth, height: source.offsetHeight }));
    return pieces.length ? { pieces, direction: way, from: previous.id, scrollTop: body.scrollTop, scrollLeft: body.scrollLeft, replaces } : null;
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    const { host, dress, shift: shiftToken, time, layer: given, skip } = this.props;
    const body = host.current;
    const ms = duration(time);
    const sheets = styles();
    if (!snapshot || !body || !ms || !sheets) return;
    if (snapshot.keep) { if (this.picture?.frame.isConnected) this.picture.rearm(); return; }
    const shift = parseFloat(token(shiftToken)) || 16;
    // The copy leaves the way the person came from: forward, it goes towards where they were; back, the other way.
    const travel = (snapshot.direction === 'back' ? 1 : -1) * shift;
    const box = body.getBoundingClientRect();
    const frame = document.createElement('div');
    frame.setAttribute(MARK, snapshot.from);
    frame.setAttribute('inert', '');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', left: `${box.left + body.clientLeft}px`, top: `${box.top + body.clientTop}px`, width: `${body.clientWidth}px`, height: `${body.clientHeight}px`,
      overflow: 'hidden', pointerEvents: 'none', zIndex: String(given ?? above(body)), backgroundColor: groundOf(body) });
    frame.dataset.phase = 'held';
    // On the page before it wears the sheets: WebKit does not apply sheets adopted by a root that is not in the document yet.
    document.body.appendChild(frame);
    // The picture it replaces goes in the same task, under the new one: no frame has neither.
    snapshot.replaces?.dismiss();
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
    for (const piece of snapshot.pieces) {
      const copy = piece.copy;
      copy.setAttribute('inert', '');
      copy.setAttribute('aria-hidden', 'true');
      Object.assign(copy.style, { position: 'absolute', top: `${piece.top - snapshot.scrollTop}px`, left: `${piece.left - snapshot.scrollLeft}px`, width: `${piece.width}px`, height: `${piece.height}px`, margin: '0', pointerEvents: 'none' });
      parent.appendChild(copy);
      for (const [target, top, left] of piece.scrolls) { target.scrollTop = top; target.scrollLeft = left; }
    }
    // The fade starts only once the new content has painted: after the browser has drawn it (the second frame after the swap; the
    // first draws it under the picture) and once it is not waiting on its own first reads (a stream held back until they have settled,
    // a list that is loading). Until then the picture stands as the old content did, at full strength, and the new content is live
    // beneath it. The wait is bounded (HOLD_MS), and a page that draws no frames lets the picture go all the same.
    let started = false;
    let leave: Animation | null = null;
    const fade = () => {
      if (started || !frame.isConnected) return;
      if (!motionAllowed()) { frame.remove(); return; }
      started = true;
      frame.dataset.phase = 'fading';
      // One fade of the whole picture (its ground with the old content on it): the new content is revealed as the old goes, a true
      // crossfade, so no frame holds the two together or only the ground.
      const mine = frame.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${travel}px)` }], { duration: ms, easing: token('--ease-in') || 'ease-in', fill: 'forwards' });
      mine.id = MOTION_ID;
      track(mine);
      const earlier = leave;
      leave = mine;
      earlier?.cancel();
      // It goes when its own fade has run to its end; one that was brought back (below) or replaced does not take it with it.
      void mine.finished.then(() => { if (leave === mine && started) frame.remove(); }, () => { if (leave === mine) frame.remove(); });
    };
    const unsettled = () => [...body.children].some((child) => !(skip && child.matches(skip)) && (child.matches(UNSETTLED) || child.querySelector(UNSETTLED) !== null));
    let since = performance.now();
    let frames = 0;
    let looping = false;
    let failsafe = 0;
    const watch = () => {
      if (started || !frame.isConnected) { looping = false; return; }
      frames += 1;
      if (frames < 2 || (unsettled() && performance.now() - since < HOLD_MS)) requestAnimationFrame(watch);
      else { looping = false; fade(); }
    };
    // Waits for the content that is in the host now. Asked again when it is replaced before the picture has gone: a picture that is
    // fading into content that is still waiting on its reads is back at full strength at once and holds until the newest content has
    // painted and settled.
    const arm = () => {
      if (started && leave && leave.playState !== 'finished') {
        // Fading into content that has already settled, it goes on (a fade that went back and forth would be a blink of its own).
        if (!unsettled()) return;
        // Fading into content that is still waiting on its reads: back to full strength at once, not by a ramp that would show that
        // content on the way, and a fade that starts afresh from there when it has settled.
        const stopped = leave;
        leave = null;
        started = false;
        stopped.cancel();
        frame.dataset.phase = 'held';
      }
      since = performance.now();
      frames = 0;
      if (!looping) { looping = true; requestAnimationFrame(watch); }
      window.clearTimeout(failsafe);
      // A page that draws no frames still lets the picture go.
      failsafe = window.setTimeout(fade, HOLD_MS + 250);
    };
    const picture: Picture = {
      frame, rearm: arm,
      opacity: () => (leave && leave.playState === 'finished' ? 0 : Number(getComputedStyle(frame).opacity)),
      dismiss: () => { const ended = leave; leave = null; started = true; ended?.cancel(); frame.remove(); },
    };
    this.picture = picture;
    arm();
  }

  render() { return this.props.children; }
}
