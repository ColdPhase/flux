import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { trapTab, usePop } from '../ui';

/**
 * A small non-modal dialog under its button (the account menu's pattern): focus moves in,
 * Tab stays inside, Escape and a click outside close it and focus returns to the button.
 */
export function Popover({ open, onClose, anchorRef, label, className, children, align = 'end' }: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  className?: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = usePop(open);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useLayoutEffect(() => {
    if (!open) return;
    const surface = ref.current;
    (surface?.querySelector<HTMLElement>('[data-autofocus]') ?? surface)?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!surface?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) onCloseRef.current();
    };
    // Escape also works after the focused control inside went away (e.g. Invite → Invited).
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.activeElement && document.activeElement !== document.body && !surface?.contains(document.activeElement)) return;
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open, anchorRef]);

  if (!pop.mounted) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); anchorRef.current?.focus(); return; }
    trapTab(event, ref.current);
  };
  return (
    <div {...pop.props} ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={['lv-pop', `lv-pop--${align}`, className].filter(Boolean).join(' ')} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
