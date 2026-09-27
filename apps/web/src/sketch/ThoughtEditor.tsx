import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { SKETCH_LIMITS } from '@flux/contracts';

/**
 * Inline editing of a thought's text, in place on the map or in the list. Enter saves,
 * Shift+Enter adds a line, Escape keeps the previous text, leaving the field saves.
 */
export function ThoughtEditor({ initial, className, style, onDone }: { initial: string; className: string; style?: CSSProperties; onDone(text: string | null): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    autosize();
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  return (
    <textarea ref={ref} className={className} style={style} rows={1} value={value} maxLength={SKETCH_LIMITS.text} aria-label="Thought text"
      onChange={(event) => { setValue(event.target.value); autosize(); }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); finish(value); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      }}
      onBlur={() => finish(value)} />
  );
}
