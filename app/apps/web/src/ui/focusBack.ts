import { useEffect, useRef, type RefObject } from 'react';

/**
 * Hands focus back to the control that opened an editor in place (Change, the icon's Change) when the editor closes, once it is
 * gone from the page and unless the person has already moved on to another control: what had focus inside the editor left with it,
 * so focus is on the page then; a control focused since keeps it. It is decided after the editor's removal is on the page, not in
 * a frame that WebKit may deliver late, after the person's next key (#1298).
 */
export function useFocusBack(opener: RefObject<HTMLElement | null>, open: boolean) {
  const was = useRef(open);
  useEffect(() => {
    const closed = was.current && !open;
    was.current = open;
    if (!closed) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) opener.current?.focus({ preventScroll: true });
  }, [open, opener]);
}
