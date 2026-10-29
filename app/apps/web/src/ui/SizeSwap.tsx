import { Component, type ReactNode, type RefObject } from 'react';
import { MOTION_ID, duration, motionAllowed, token, track } from './motion';
import { copyOf, groundOf, restoreScrolls, scrolls, styles } from './Dissolve';

/**
 * A host that takes another size when its content changes between two renderings, the sidebar between its full width and its 64 px
 * rail (#720): the host's width goes from where it was to where it settles over `--dur-in` (`--ease-out`), and the old rendering
 * stays as an inert picture of itself over the new for `--dur-out` and fades away. The new rendering is put in one commit, in place
 * and live from the first frame, at the width of its own: the host clips it while it grows or shrinks, so what is in it never
 * reflows or moves during the change. The width of the host is the one layout property that animates, and the work area follows it
 * (the person asked for that change; its top, bottom and far edge do not move). A switch in a viewport (the tablet's rail) is not a
 * change of the content and is never animated. Reduced motion, a hidden page and the first screen simply swap.
 *
 * The picture is as `Dissolve`'s: no ids, `inert`, `aria-hidden`, no pointer input, inside a closed shadow root that wears the page's
 * style sheets, so no query of the page finds a second copy of the sidebar. Where the control that had focus was replaced, its
 * counterpart in the new rendering (`keep`) has it, with or without motion.
 */
interface Props {
  /** What the content is: when it changes, the host takes the size of the new rendering. */
  id: string;
  host: RefObject<HTMLElement | null>;
  /** The class the picture's one box-less ancestor wears, so the selectors that read it style the picture as the original. */
  dress: string;
  /** The control that keeps focus across the change (a selector in the content). */
  keep: string;
  /** The width token each `id` settles at, so the new width is known without laying the page out in the commit (one layout, not two). */
  widths: Record<string, '--side-w' | '--rail-w'>;
  /** The host does not change its size at all now (a viewport that has the rail anyway): the content changes and nothing animates. */
  still?: boolean;
  children: ReactNode;
}

interface Snapshot { copy: HTMLElement | null; width: number; contentWidth: number; scrolls: [number, number, number][]; focused: boolean }

const MARK = 'data-size-picture';

export class SizeSwap extends Component<Props, Record<string, never>, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { id, host: ref, keep } = this.props;
    const host = ref.current;
    const content = host?.firstElementChild;
    if (previous.id === id || !host || !(content instanceof HTMLElement)) return null;
    const active = document.activeElement;
    const focused = !!active && content.contains(active) && active.matches(keep);
    const animate = !this.props.still && motionAllowed() && !!duration('--dur-in') && !!styles();
    return { copy: animate ? copyOf(content) : null, width: host.getBoundingClientRect().width, contentWidth: content.offsetWidth, scrolls: animate ? scrolls(content) : [], focused };
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
    const { host: ref, keep } = this.props;
    const host = ref.current;
    if (!host || !snapshot) return;
    this.fold(host, snapshot);
    // Focus is where the person had it: the control they used has a counterpart in the new rendering. It is put there after the change
    // has been asked for, so the layout it needs is the one the first frame draws anyway (one layout, not two).
    const active = document.activeElement;
    if (snapshot.focused && (!active || active === document.body || !active.isConnected)) host.querySelector<HTMLElement>(keep)?.focus({ preventScroll: true });
  }

  private fold(host: HTMLElement, snapshot: Snapshot) {
    const { dress, widths, id } = this.props;
    host.querySelectorAll(`:scope > [${MARK}]`).forEach((frame) => frame.remove());
    // Where the width is now, with an earlier change still running, was read before the update (`snapshot.width`).
    host.getAnimations().filter((animation) => animation.id === MOTION_ID).forEach((animation) => animation.cancel());
    const sheets = styles();
    const grow = duration('--dur-in');
    const leave = duration('--dur-out');
    const to = parseFloat(token(widths[id] ?? '')) || 0;
    if (!snapshot.copy || !sheets || !grow || !to || Math.abs(to - snapshot.width) < 1) return;
    const frame = document.createElement('div');
    frame.setAttribute(MARK, '');
    frame.setAttribute('inert', '');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'absolute', left: '0', top: '0', bottom: '0', width: `${snapshot.contentWidth}px`, overflow: 'hidden', pointerEvents: 'none', zIndex: '2', backgroundColor: groundOf(host) });
    host.appendChild(frame);
    const root = frame.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = sheets;
    const dressing = document.createElement(host.tagName);
    dressing.className = dress;
    dressing.style.display = 'contents';
    root.appendChild(dressing);
    const copy = snapshot.copy;
    copy.setAttribute('inert', '');
    copy.setAttribute('aria-hidden', 'true');
    Object.assign(copy.style, { height: '100%', margin: '0', pointerEvents: 'none' });
    dressing.appendChild(copy);
    host.style.overflow = 'hidden';
    const size = host.animate([{ width: `${snapshot.width}px` }, { width: `${to}px` }], { duration: grow, easing: token('--ease-out') || 'ease-out' });
    size.id = MOTION_ID;
    track(size);
    const fade = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: leave || grow, easing: token('--ease-in') || 'ease-in', fill: 'forwards' });
    fade.id = MOTION_ID;
    track(fade);
    // Last: setting a scroll position needs the layout the first frame draws, which the change has now been asked for.
    restoreScrolls(copy, snapshot.scrolls);
    const done = () => { frame.remove(); if (!host.getAnimations().some((animation) => animation.id === MOTION_ID && animation.playState === 'running')) host.style.removeProperty('overflow'); };
    void Promise.all([size.finished, fade.finished]).then(done, done);
  }

  render() { return this.props.children; }
}
