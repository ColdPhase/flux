import { Component, type ReactNode, type RefObject } from 'react';
import { MOTION_ID, duration, motionAllowed, token, travelDirection, type TravelDirection } from './motion';

/**
 * What was in the panel dissolves into what replaces it (#593 AC-2). The panel swaps its content in one commit; this keeps the
 * outgoing content on screen as an inert picture of itself and fades it away (opacity, and a few pixels of travel towards where
 * the person came from) over the new content, which slides in from the other side (SidePanel's `usePanelSwap`). So there is never
 * a blank cut, and the panel's shell, head and controls never move (Spokój rule 7). Reduced motion, a hidden page and the first
 * screen simply swap.
 *
 * It renders its children and nothing else: it is a class only because React offers the moment before the swap (what the
 * outgoing content looks like) to class components alone, in `getSnapshotBeforeUpdate`. The picture is a deep copy without ids,
 * `inert` and `aria-hidden`, and it takes no pointer input. Scroll positions inside it are copied, so the old content does not
 * jump. (Views dissolve through the View Transitions API instead, see `viewTransition.ts`: a picture of a whole view in the
 * document would answer the same selectors as the view itself.)
 */
interface Props {
  /** What the content is: when it changes, the old content dissolves. */
  id: string;
  /** How many steps of "‹ back" lie behind the content; a lower number than before is back. */
  depth?: number;
  /** The panel's body: the copies are its children and lie over it. */
  host: RefObject<HTMLElement | null>;
  children: ReactNode;
}

interface Piece { copy: HTMLElement; top: number; left: number; width: number; height: number; scrolls: [number, number, number][] }
interface Snapshot { pieces: Piece[]; direction: TravelDirection }

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

export class Dissolve extends Component<Props, Record<string, never>, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { id, depth = 0, host } = this.props;
    const body = host.current;
    if (previous.id === id || !body || !motionAllowed() || !duration('--dur-out')) return null;
    const direction: TravelDirection = depth > (previous.depth ?? 0) ? 'forward' : depth < (previous.depth ?? 0) ? 'back' : travelDirection();
    const pieces = [...body.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute(MARK) && child.offsetWidth > 0 && child.offsetHeight > 0)
      .map((source) => ({ copy: copyOf(source), top: source.offsetTop, left: source.offsetLeft, width: source.offsetWidth, height: source.offsetHeight, scrolls: scrolls(source) }));
    return pieces.length ? { pieces, direction } : null;
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    const body = this.props.host.current;
    const ms = duration('--dur-out');
    if (!snapshot || !body || !ms) return;
    const shift = parseFloat(token('--shift-panel')) || 16;
    // The copy leaves the way the person came from: forward, it goes towards where they were; back, the other way.
    const travel = (snapshot.direction === 'back' ? 1 : -1) * shift;
    for (const piece of snapshot.pieces) {
      const copy = piece.copy;
      copy.setAttribute(MARK, '');
      copy.setAttribute('inert', '');
      copy.setAttribute('aria-hidden', 'true');
      Object.assign(copy.style, { position: 'absolute', top: `${piece.top}px`, left: `${piece.left}px`, width: `${piece.width}px`, height: `${piece.height}px`, margin: '0', zIndex: '2', pointerEvents: 'none' });
      body.appendChild(copy);
      const nodes = copy.querySelectorAll<HTMLElement>('*');
      for (const [index, top, left] of piece.scrolls) { const target = index < 0 ? copy : nodes[index]; if (target) { target.scrollTop = top; target.scrollLeft = left; } }
      const leave = copy.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${travel}px)` }], { duration: ms, easing: token('--ease-in') || 'ease-in', fill: 'forwards' });
      leave.id = MOTION_ID;
      void leave.finished.then(() => copy.remove(), () => copy.remove());
    }
  }

  render() { return this.props.children; }
}
