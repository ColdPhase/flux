import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { IconButton } from './Button';
import { MEDIA, duration, play, useMediaQuery } from './motion';
import { Overlay, Sheet, usePresence } from './Overlay';

export type SidePanelMode = 'docked' | 'overlay' | 'sheet';

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional header content before the title, e.g. a Back button when drilling down. */
  headerStart?: ReactNode;
  /** Persistent context below the heading, outside the scrolling panel body. */
  context?: ReactNode;
  id?: string;
  /** The kind of object shown, as a chip in the head ("Task", "Decision"); its number joins it. */
  chip?: string;
  children: ReactNode;
}

/** Where an object's own number ("#8") lands in the panel head; see `PanelMeta`. */
export const PANEL_META_ID = 'details-meta';

/** Docked beside the work above 980px, an overlay down to the phone, a full-screen sheet on the phone. */
export function useSidePanelMode(): SidePanelMode {
  const overlay = useMediaQuery(MEDIA.panelOverlay);
  const phone = useMediaQuery(MEDIA.phone);
  return phone ? 'sheet' : overlay ? 'overlay' : 'docked';
}

function PanelContent({ title, titleId, headerStart, chip, hint, context, onClose, bodyRef, children }: { title: string; titleId: string; headerStart?: ReactNode; chip?: string; hint?: boolean; context?: ReactNode; onClose: () => void; bodyRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <>
      <div className="ui-panel__head">
        {headerStart}
        {chip
          ? <h2 className="ui-panel__chip" id={titleId}><span className="ui-vh">{title}: </span><span className="ui-panel__kind">{chip}</span></h2>
          : <h2 className="ui-panel__title" id={titleId}>{title}</h2>}
        {chip ? <span className="ui-panel__meta" id={PANEL_META_ID} /> : null}
        {chip && hint ? <span className="ui-panel__hint" aria-hidden="true">Drag up for more</span> : <span className="ui-panel__fill" />}
        <IconButton icon="x" label={`Close ${title.toLowerCase()}`} onClick={onClose} className="ui-panel__close" />
      </div>
      {context}
      <div className="ui-panel__body" ref={bodyRef} tabIndex={-1}>{children}</div>
    </>
  );
}

/** Non-modal panel docked at the right edge of the app frame. Esc inside it closes it. */
function DockedPanel({ open, onClose, title, headerStart, chip, context, id, children }: SidePanelProps) {
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
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  };
  return (
    <aside ref={ref} id={id} className="ui-panel ui-panel--docked" aria-labelledby={titleId} onKeyDown={onKeyDown} inert={!open}>
      <PanelContent title={title} titleId={titleId} headerStart={headerStart} chip={chip} context={context} onClose={onClose} bodyRef={bodyRef}>{children}</PanelContent>
    </aside>
  );
}

export function SidePanel(props: SidePanelProps) {
  const mode = useSidePanelMode();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  if (mode === 'docked') return <DockedPanel {...props} />;
  const content = <PanelContent title={props.title} titleId={titleId} headerStart={props.headerStart} chip={props.chip} hint={mode === 'sheet'} context={props.context} onClose={props.onClose} bodyRef={bodyRef}>{props.children}</PanelContent>;
  if (mode === 'sheet') {
    return <Sheet open={props.open} onClose={props.onClose} labelledBy={titleId} id={props.id} initialFocus={bodyRef} detents={!!props.chip} className="ui-panel">{content}</Sheet>;
  }
  return <Overlay placement="right" open={props.open} onClose={props.onClose} labelledBy={titleId} id={props.id} initialFocus={bodyRef} className="ui-panel ui-panel--overlay">{content}</Overlay>;
}
