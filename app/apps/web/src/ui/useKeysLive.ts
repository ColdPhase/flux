import { useEffect, useState } from 'react';
import { isTyping } from './keys';

/**
 * Whether the single keys are shortcuts now: no field has focus (F-026 §4). Read as focus moves. A key is shown beside its action (New's
 * C, a toast's Z) only while it works; in a composer or any other field it is typing.
 */
export function useKeysLive(): boolean {
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
