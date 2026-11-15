import { useEffect, useState } from 'react';
import { Icon } from '../ui';
import { isTyping } from '../ui/keys';

/** Whether the single keys are shortcuts now: no field has focus (F-026 §4). Read as focus moves. */
function useKeysLive(): boolean {
  const [live, setLive] = useState(() => typeof document === 'undefined' || !isTyping(document.activeElement));
  useEffect(() => {
    let frame = 0;
    const read = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setLive(!isTyping(document.activeElement))); };
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    read();
    return () => { cancelAnimationFrame(frame); document.removeEventListener('focusin', read); document.removeEventListener('focusout', read); };
  }, []);
  return live;
}

/**
 * New (C), always in the same place at the top of the sidebar (F-026 S3). It opens the one Create
 * window (#345); the other things that can be made are one step away inside it. Its `C` shows only while C works: in a composer or any
 * other field the key is typing (F-026 §4, persona round 27 P2 7).
 */
export function NewMenu({ onNew, compact = false }: { onNew: () => void; compact?: boolean }) {
  const live = useKeysLive();
  return (
    <div className={`newmenu${compact ? ' newmenu--compact' : ''}`}>
      <button type="button" className="side__new" aria-haspopup="dialog" aria-keyshortcuts="C"
        aria-label={compact ? 'New' : undefined} title={compact ? (live ? 'New (C)' : 'New') : undefined} onClick={onNew}>
        <Icon name="plus" size={16} />{compact ? null : <>New<kbd aria-hidden="true" style={live ? undefined : { visibility: 'hidden' }}>C</kbd></>}
      </button>
    </div>
  );
}
