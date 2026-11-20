import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { MEDIA, duration, motionAllowed, settle, token, useMediaQuery } from './motion';
import { DetentSheet } from './DetentSheet';
import { Overlay, Sheet, usePresence } from './Overlay';
import { isTyping } from './keys';

export type SidePanelMode = 'docked' | 'overlay' | 'sheet';

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The close control's name; "Close <title>" when omitted. */
  closeLabel?: string;
  /** "‹ Task #1": where Back goes when this content replaced another in the panel (Spokój rule 2). */
  back?: { label: string; onClick: () => void };
  /** Persistent context below the heading, outside the scrolling panel body. */
  context?: ReactNode;
  id?: string;
  /** The kind of object shown, as a chip in the head ("Task", "Decision"); its number joins it. */
  chip?: string;
  /** On a phone the sheet opens at full height (a thread); the height then stays while the content changes. */
  startFull?: boolean;
  /**
   * On a phone Back closes the panel first (#1545). A panel that is a history entry of its own (a task or a decision named by `?open=`, a thread,
   * an agent's chat) leaves it off: Back over that entry is its way back.
   */
  backLayer?: boolean;
  /**
   * Names what the panel shows. When it changes while the panel stays open, the body's content is in place at once
   * and fades in; the shell and the head do not move (#863). Without it the kind chip and the title tell.
   */
  contentKey?: string;
  /** Told the height whenever the phone's sheet changes it, so a return to the screen can open it as it was (#592). */
  onHeight?: (full: boolean) => void;
  /**
   * Where focus goes back when what opened the panel is gone or was nothing (a task made in the Create window opens here, and the window has
   * left): the shown object's own card or row, so closing never leaves focus on the page's body.
   */
  focusBack?: () => HTMLElement | null;
  children: ReactNode;
}

/**
 * The panel's content changes (task, thread, "‹ back"): the new content is in place at once and fades in over --dur-1 on --ease-out
 * (#863, motion rule 2). The old content is never held and nothing travels; only the body's own content fades: the panel, its head
 * row and its controls stay put. Content that arrives a moment later (a lazily loaded view) is not a change and does not fade.
 */
function usePanelSwap(body: RefObject<HTMLElement | null>, enabled: boolean, open: boolean, key: string) {
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !open) { previous.current = null; return; }
    const before = previous.current;
    previous.current = key;
    const node = body.current;
    if (before === null || before === key || !node || !motionAllowed()) return;
    const ms = duration('--dur-1');
    if (!ms) return;
    for (const child of node.children) void settle(child, { opacity: 1 }, ms, '--ease-out', { from: { opacity: 0 } });
  }, [body, enabled, open, key]);
}

/** Where an object's own number ("#8") lands in the panel head; see `PanelMeta`. */
/**
 * Sent (bubbling) by an object's card that a closing panel gave the focus to: the card is now where the person is, so a view that keeps its
 * reading place while the layout changes (a conversation, as the panel leaves) brings it into view and keeps it there instead (personas-37).
 */
export const REVEAL_EVENT = 'flux:reveal';
export const PANEL_META_ID = 'details-meta';
/** Where the object's state glyph sits before its kind, and its quiet actions (⋯) before the close control. */
export const PANEL_GLYPH_ID = 'details-glyph';
export const PANEL_ACTIONS_ID = 'details-actions';

const noSubscription = () => () => {};
function PanelPortal({ id, children }: { id: string; children: ReactNode }) {
  const target = useSyncExternalStore(noSubscription, () => document.getElementById(id), () => null);
  return target ? createPortal(children, target) : null;
}
/** Puts a short piece of text in the panel's head beside its kind chip: a task's number, a thread's reply count. */
export const PanelMeta = ({ children }: { children: ReactNode }) => <PanelPortal id={PANEL_META_ID}>{children}</PanelPortal>;
/** Puts the open object's state glyph in the head, before its kind. */
export const PanelGlyph = ({ children }: { children: ReactNode }) => <PanelPortal id={PANEL_GLYPH_ID}>{children}</PanelPortal>;
/** Puts the open object's ⋯ menu in the head, beside the close control. */
export const PanelActions = ({ children }: { children: ReactNode }) => <PanelPortal id={PANEL_ACTIONS_ID}>{children}</PanelPortal>;

/**
 * The one panel's forms (#1365): docked beside the work above 1000 px, and from 641 to 1000 px the same non-modal card laid over the work's
 * right edge ('overlay'), under the header in both so the header and a call's strip stay live; a full-screen sheet on the phone.
 */
export function useSidePanelMode(): SidePanelMode {
  const overlay = useMediaQuery(MEDIA.panelOverlay);
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? 'sheet' : overlay ? 'overlay' : 'docked';
}

function PanelContent({ title, titleId, closeLabel, back, chip, context, onClose, bodyRef, contentKey, children }: { title: string; titleId: string; closeLabel?: string; back?: SidePanelProps['back']; chip?: string; context?: ReactNode; onClose: () => void; bodyRef: RefObject<HTMLDivElement | null>; contentKey: string; children: ReactNode }) {
  // Content that takes the place of another in an open panel (an object opened from a thread's button): the control that was
  // pressed is gone with the old content, and focus must not fall to the page. A panel that has just opened is placed by its surface.
  const shown = useRef(contentKey);
  useLayoutEffect(() => {
    if (shown.current === contentKey) return;
    shown.current = contentKey;
    const active = document.activeElement;
    if (!active || active === document.body) bodyRef.current?.focus({ preventScroll: true });
  }, [contentKey, bodyRef]);
  return (
    <>
      <div className="ui-panel__head">
        {back ? <button type="button" className="ui-panel__back" onClick={back.onClick}><Icon name="chevron-left" size={14} /><span>{back.label}</span></button> : null}
        {back ? <span className="ui-panel__sep" aria-hidden="true">/</span> : null}
        {chip
          ? <h2 className="ui-panel__chip" id={titleId}><span className="ui-vh">{title}: </span><span className="ui-panel__kind"><span className="ui-panel__glyph" id={PANEL_GLYPH_ID} /><span className="ui-panel__word">{chip}</span></span></h2>
          : <h2 className="ui-panel__title" id={titleId}>{title}</h2>}
        {chip ? <span className="ui-panel__meta" id={PANEL_META_ID} /> : null}
        <span className="ui-panel__fill" />
        {chip ? <span className="ui-panel__actions" id={PANEL_ACTIONS_ID} /> : null}
        <IconButton icon="x" label={closeLabel ?? `Close ${title.toLowerCase()}`} data-tip="Close · Esc" onClick={onClose} className="ui-panel__close" />
      </div>
      {context}
      <div className="ui-panel__body" ref={bodyRef} tabIndex={-1}>{children}</div>
    </>
  );
}

/** Non-modal panel at the right edge of the app frame, under the header. Esc inside it closes it. `float` lays it over the work instead of beside it. */
/**
 * Set by Create as it closes to open what it made in the panel (F-026 §4, personas-36): what opened that panel is gone, so closing it gives
 * the focus to the object's own card, never to the control the window was opened over or wherever the focus fell meanwhile. For the next
 * panel that opens or changes within a few seconds.
 */
let objectTakesFocusBackUntil = 0;
export function returnFocusToObject() { objectTakesFocusBackUntil = performance.now() + 5000; }
function takeObjectReturn() { const due = objectTakesFocusBackUntil > performance.now(); objectTakesFocusBackUntil = 0; return due; }

function DockedPanel({ open, onClose, title, closeLabel, back, chip, context, id, contentKey, float, focusBack, children }: SidePanelProps & { float?: boolean }) {
  const { mounted, unmount } = usePresence(open);
  const focusBackRef = useRef(focusBack);
  useEffect(() => { focusBackRef.current = focusBack; });
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const titleId = useId();
  useEffect(() => { openRef.current = open; });
  usePanelSwap(bodyRef, true, open && mounted, contentKey ?? `${chip ?? ''}|${title}`);
  // Something opened into the open panel from outside it (a task card in the stream while a thread is shown): closing gives focus back to
  // that control, not to what opened the panel first (a message the link arrived at, far above, or nothing).
  const shownKey = contentKey ?? `${chip ?? ''}|${title}`;
  const opened = useRef(false);
  const toObject = useRef(false);
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    if (takeObjectReturn()) { returnRef.current = null; if (!opened.current) toObject.current = true; return; }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !ref.current?.contains(active)) returnRef.current = active;
    // Only a change of what the panel shows; opening is the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    // Remember the opener before focus moves into the surface; a panel Create opened has none left (its object's card stands for it).
    returnRef.current = toObject.current || takeObjectReturn() ? null : document.activeElement as HTMLElement | null;
    toObject.current = false;
    opened.current = true;
    const panel = ref.current;
    panel?.classList.remove('is-leaving');
    // Opening while it is leaving continues from where the exit had got to; opening at first paint does not move.
    const shift = token('--shift-panel') || '16px';
    void settle(panel, { opacity: 1, transform: 'none' }, duration('--dur-in'), '--ease-out', { from: { opacity: 0, transform: `translateX(${shift})` } });
    // A composer beside it that has the cursor, or is getting it (Discuss: "ready to write", F-026 §4), keeps it; the panel is beside it.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement && !panel?.contains(active) && active.closest('.composer, .composer__box')) && !isTyping(null)) bodyRef.current?.focus({ preventScroll: true });
    return () => {
      opened.current = false;
      const target = returnRef.current;
      returnRef.current = null;
      // The work area takes the space back at once while the panel fades out over it; focus has already returned.
      panel?.classList.add('is-leaving');
      // What had focus inside the panel went with it, and so did a focus the page lost on the way (WebKit drops it to the page while the
      // panel's content is still being read in): both are handed back, as useFocusBack does. A control the person moved to keeps it.
      const handBack = () => {
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected;
        if (!panel?.contains(active) && !lost) return;
        // A control that is still there takes it back; one that is gone, hidden or inert (the Create window's field, after Create task) cannot.
        if (target && target !== document.body && target.isConnected) {
          target.focus({ preventScroll: true });
          if (document.activeElement === target) return;
        }
        // The object's own card may be out of view (a new task's card at the end of the stream): it comes into view with the focus. The
        // conversation keeps its reading place while the panel leaves, which would scroll the card out again (personas-37): the card says it
        // is now the place to keep (`REVEAL_EVENT`), and a view that keeps a place brings it into view and keeps it there.
        const card = focusBackRef.current?.();
        if (card) {
          card.focus();
          card.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
        }
      };
      handBack();
      // WebKit can take focus off the control again as the panel is made inert, a moment after it was given: if the page has no focus once
      // that frame is in, it is handed back once more. A person who has moved on to a control of their own has focus on it, so it stays.
      requestAnimationFrame(handBack);
      void settle(panel, { opacity: 0, transform: `translateX(${shift})` }, duration('--dur-out'), '--ease-in', { from: { opacity: 1, transform: 'none' }, fill: 'forwards' })
        .then(() => { if (!openRef.current) unmount(); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  if (!mounted) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // An Escape that ends an input method's composition, or that a field inside already used, is not a request to close.
    if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
  };
  return (
    <aside ref={ref} id={id} className={`ui-panel ui-panel--docked${float ? ' ui-panel--float' : ''}`} aria-labelledby={titleId} onKeyDown={onKeyDown} inert={!open}>
      <PanelContent title={title} titleId={titleId} closeLabel={closeLabel} back={back} chip={chip} context={context} onClose={onClose} bodyRef={bodyRef} contentKey={contentKey ?? `${chip ?? ''}|${title}`}>{children}</PanelContent>
    </aside>
  );
}

/**
 * A panel leaves as it was (#901, motion rule 3). While it is closing the app has already moved on: a thread's panel has lost its kind
 * ("Thread" is no chip any more, the head would read "Details") and, on a phone, the sheet for a task, a decision or a thread would change
 * into the plain full sheet, which unmounts the one that is leaving, so it vanished with no fade. What the head says and which kind of
 * sheet it is therefore come from the last time the panel was open, for the length of its exit. So does the body: a thread closed with the browser's
 * Back arrives at the entry before it, whose panel was shut, and the shell then puts that entry's own view in the panel (the slot the thread's copy
 * stands in is replaced), which emptied the panel, or filled it with something else, in the middle of its fade (`test_light_motion` `test_10k`).
 */
type Head = Pick<SidePanelProps, 'title' | 'closeLabel' | 'chip' | 'contentKey' | 'back' | 'context'>;
function useLeavingHead(props: SidePanelProps): SidePanelProps {
  const head: Head = { title: props.title, closeLabel: props.closeLabel, chip: props.chip, contentKey: props.contentKey, back: props.back, context: props.context };
  const [last, setLast] = useState<Head>(head);
  // Remembered while open, only when what the head says changes (a state that follows what it is rendered from).
  if (props.open && (last.title !== head.title || last.closeLabel !== head.closeLabel || last.chip !== head.chip || last.contentKey !== head.contentKey || last.back?.label !== head.back?.label)) setLast(head);
  // The body is the content the panel was given while it was open, whatever the shell has put there since.
  const [body, setBody] = useState(props.children);
  if (props.open && body !== props.children) setBody(props.children);
  return props.open ? props : { ...props, ...last, children: body };
}

export function SidePanel(live: SidePanelProps) {
  const props = useLeavingHead(live);
  const mode = useSidePanelMode();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  usePanelSwap(bodyRef, mode === 'sheet', props.open, props.contentKey ?? `${props.chip ?? ''}|${props.title}`);
  if (mode !== 'sheet') return <DockedPanel {...props} float={mode === 'overlay'} />;
  const content = <PanelContent title={props.title} titleId={titleId} closeLabel={props.closeLabel} back={props.back} chip={props.chip} context={props.context} onClose={props.onClose} bodyRef={bodyRef}
    contentKey={props.contentKey ?? `${props.chip ?? ''}|${props.title}`}>{props.children}</PanelContent>;
  // A task, decision or result opens in the one two-height sheet; other Details stay a full sheet.
  if (props.chip) {
    return (
      <Overlay placement="bottom" bare keepLiveStrip backLayer={props.backLayer ?? false} open={props.open} onClose={props.onClose} initialFocus={bodyRef}>
        <DetentSheet id={props.id} role="dialog" aria-modal aria-labelledby={titleId} startFull={props.startFull} onHeight={props.onHeight} onClose={props.onClose} className="ui-panel">{content}</DetentSheet>
      </Overlay>
    );
  }
  return <Sheet open={props.open} onClose={props.onClose} labelledBy={titleId} id={props.id} initialFocus={bodyRef} keepLiveStrip backLayer={props.backLayer ?? false} className="ui-panel">{content}</Sheet>;
}
