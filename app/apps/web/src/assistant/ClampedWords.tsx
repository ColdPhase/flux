import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import './clamped-words.css';

/**
 * Words an agent would send someone, in a few lines with "Show all" (#1089): the OK card and the Inbox stay calm, and every word is one
 * tap away before the OK. The button shows only when the words do not fit.
 */
export function ClampedWords({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && !open) setLong(element.scrollHeight > element.clientHeight + 1);
  }, [text, open]);
  return (
    <>
      <span ref={ref} className={`clamped-words${open ? '' : ' clamped-words--closed'}${className ? ` ${className}` : ''}`}>{text}</span>
      {long || open ? <Button variant="link" className="clamped-words__more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Show less' : 'Show all'}</Button> : null}
    </>
  );
}
