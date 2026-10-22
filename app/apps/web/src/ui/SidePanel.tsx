import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { MEDIA, duration, play, useMediaQuery } from './motion';
import { DetentSheet } from './DetentSheet';
import { Overlay, Sheet, usePresence } from './Overlay';

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
  /** Told the height whenever the phone's sheet changes it, so a return to the screen can open it as it was (#592). */
  onHeight?: (full: boolean) => void;
  children: ReactNode;
}

/** Where an object's own number ("#8") lands in the panel head; see `PanelMeta`. */
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

/** Docked beside the work above 980px, an overlay down to the phone, a full-screen sheet on the phone. */
export function useSidePanelMode(): SidePanelMode {
  const overlay = useMediaQuery(MEDIA.panelOverlay);
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? 'sheet' : overlay ? 'overlay' : 'docked';
}

function PanelContent({ title, titleId, closeLabel, back, chip, context, onClose, bodyRef, children }: { title: string; titleId: string; closeLabel?: string; back?: SidePanelProps['back']; chip?: string; context?: ReactNode; onClose: () => void; bodyRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <>
      <div className="ui-panel__head">
        {back ? <button type="button" className="ui-panel__back" onClick={back.onClick}><Icon name="chevron-left" size={14} /><span>{back.label}</span></button> : null}
        {back ? <span className="ui-panel__sep" aria-hidden="true">/</span> : null}
        {chip
          ? <h2 className="ui-panel__chip" id={titleId}><span className="ui-vh">{title}: </span><span className="ui-panel__kind"><span className="ui-panel__glyph" id={PANEL_GLYPH_ID} />{chip}</span></h2>
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

/** Non-modal panel docked at the right edge of the app frame. Esc inside it closes it. */
function DockedPanel({ open, onClose, title, closeLabel, back, chip, context, id, children }: SidePanelProps) {
  const { mounted, unmount } = usePresence(open);
  const ref = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const titleId = useId();
  useEffect(() => { openRef.current = open; });

  useLayoutEffect(() => {
    if (!open || !mounted) return;
    // Remember the opener before focus moves into the surface.
    returnRef.current = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    panel?.getAnimations().forEach((animation) => animation.cancel());
    panel?.classList.remove('is-leaving');
    void play(panel, [{ transform: 'translateX(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], duration('--dur-3'), '--ease-out', { fill: 'backwards' });
    bodyRef.current?.focus({ preventScroll: true });
    return () => {
      const target = returnRef.current;
      returnRef.current = null;
      // The work area takes the space back at once while the panel fades out over it.
      panel?.classList.add('is-leaving');
      if (panel?.contains(document.activeElement) && target?.isConnected) target.focus({ preventScroll: true });
      void play(panel, [{ transform: 'none', opacity: 1 }, { transform: 'translateX(16px)', opacity: 0 }], duration('--dur-2'), '--ease-in', { fill: 'forwards' })
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
    <aside ref={ref} id={id} className="ui-panel ui-panel--docked" aria-labelledby={titleId} onKeyDown={onKeyDown} inert={!open}>
      <PanelContent title={title} titleId={titleId} closeLabel={closeLabel} back={back} chip={chip} context={context} onClose={onClose} bodyRef={bodyRef}>{children}</PanelContent>
    </aside>
  );
}

export function SidePanel(props: SidePanelProps) {
  const mode = useSidePanelMode();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  if (mode === 'docked') return <DockedPanel {...props} />;
  const content = <PanelContent title={props.title} titleId={titleId} closeLabel={props.closeLabel} back={props.back} chip={props.chip} context={props.context} onClose={props.onClose} bodyRef={bodyRef}>{props.children}</PanelContent>;
  if (mode === 'sheet') {
    // A task, decision or result opens in the one two-height sheet; other Details stay a full sheet.
    if (props.chip) {
      return (
        <Overlay placement="bottom" bare keepLiveStrip open={props.open} onClose={props.onClose} initialFocus={bodyRef}>
          <DetentSheet id={props.id} role="dialog" aria-modal aria-labelledby={titleId} startFull={props.startFull} onHeight={props.onHeight} onClose={props.onClose} className="ui-panel">{content}</DetentSheet>
        </Overlay>
      );
    }
    return <Sheet open={props.open} onClose={props.onClose} labelledBy={titleId} id={props.id} initialFocus={bodyRef} keepLiveStrip className="ui-panel">{content}</Sheet>;
  }
  return <Overlay placement="right" keepLiveStrip open={props.open} onClose={props.onClose} labelledBy={titleId} id={props.id} initialFocus={bodyRef} className="ui-panel ui-panel--overlay">{content}</Overlay>;
}
