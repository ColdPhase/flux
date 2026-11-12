import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

/**
 * A fenced code block of a message (#1247, F-026 §6): the text as it was typed, in the mono face on the `--sub` surface, one line per line
 * with a horizontal scroll of its own, and Copy. The code is a text node: nothing in it is read as a mark, a chip or a link.
 */
export function CodeBlock({ code, lang = null }: { code: string; lang?: string | null }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const text = useRef<HTMLElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let next: 'copied' | 'failed' = 'copied';
    try { await navigator.clipboard.writeText(code); } catch {
      // No clipboard here (a page that is not secure): leave the code selected, so the keys copy it.
      next = 'failed';
      if (text.current) window.getSelection()?.selectAllChildren(text.current);
    }
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <div className="msg-codeblock" data-ref="code">
      <div className="msg-codeblock__bar">
        {lang ? <span className="msg-codeblock__lang">{lang}</span> : <span />}
        <Button variant="quiet" size="sm" icon={state === 'copied' ? 'check' : 'copy'} aria-label="Copy code" onClick={() => void copy()}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C' : 'Copy'}
        </Button>
      </div>
      <pre className="msg-codeblock__pre" tabIndex={0} role="group" aria-label={lang ? `Code, ${lang}` : "Code"}><code ref={text}>{code}</code></pre>
      <span className="ui-vh" role="status">{state === 'copied' ? 'Code copied' : ''}</span>
    </div>
  );
}
