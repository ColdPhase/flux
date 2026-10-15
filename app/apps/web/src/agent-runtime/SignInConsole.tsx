import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  AGENT_RUNTIME_CONSOLE_INPUT_CHARS, AGENT_RUNTIME_CONSOLE_SIZE,
  type AgentRuntimeConsoleClientMessage, type AgentRuntimeConsoleError, type AgentRuntimeConsoleServerMessage, type AgentRuntimeStatus,
} from '@flux/contracts';
import { Button, Icon, Spinner } from '../ui';
import { consoleSocketUrl } from './api';

// The sign-in console's terminal (F-022 T4 #279): xterm.js over the session-bound WebSocket to the PTY
// in the owner's runtime, which runs exactly the chosen `claude auth login` command. What Claude Code
// prints arrives as binary messages and is only drawn; what the owner types or pastes goes to the CLI's
// own prompt. Nothing here is stored. Loaded only on the sign-in page.

export interface ConsoleOutcome {
  signedIn: boolean;
  ended: 'exited' | 'timed_out' | null;
  error: AgentRuntimeConsoleError | 'cancelled' | 'superseded' | null;
  status: AgentRuntimeStatus | null;
}

type Phase = 'connecting' | 'starting' | 'running' | 'checking';
const PHASE_TEXT: Record<Phase, string> = {
  connecting: 'Connecting to your runtime…',
  starting: 'Starting Claude Code’s sign-in…',
  running: 'Claude Code is waiting for you to sign in.',
  checking: 'Asking Claude Code whether you are signed in…',
};

const clamp = (value: number, range: { min: number; max: number }) => Math.max(range.min, Math.min(range.max, value));

/** The pieces of `text` that fit one input message each. */
function chunks(text: string): string[] {
  const out: string[] = [];
  const points = [...text];
  for (let start = 0; start < points.length; start += AGENT_RUNTIME_CONSOLE_INPUT_CHARS) out.push(points.slice(start, start + AGENT_RUNTIME_CONSOLE_INPUT_CHARS).join(''));
  return out;
}

const safeLink = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url : null; } catch { return null; }
};

export default function SignInConsole({ ticket, methodTitle, onEnd }: { ticket: string; methodTitle: string; onEnd: (outcome: ConsoleOutcome) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [link, setLink] = useState<URL | null>(null);
  const [code, setCode] = useState('');
  const endRef = useRef(onEnd);
  const cancelled = useRef(false);
  useEffect(() => { endRef.current = onEnd; }, [onEnd]);

  useEffect(() => {
    const element = host.current!;
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const open = (event: MouseEvent | null, uri: string) => { event?.preventDefault(); if (safeLink(uri)) window.open(uri, '_blank', 'noopener,noreferrer'); };
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: narrow ? 13 : 14,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: false,
      scrollback: 500,
      theme: { background: '#16181d', foreground: '#e8e9ec', cursor: '#e8e9ec', selectionBackground: '#3a4252' },
      // The CLI marks its sign-in URL as a hyperlink (OSC 8); only https links open, in a new tab.
      linkHandler: { activate: (event, text) => open(event, text), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => open(event, uri)));
    // The same hyperlink also becomes a large "Open the sign-in page" button, easier to tap on a phone.
    term.parser.registerOscHandler(8, (data) => {
      const uri = data.slice(data.indexOf(';') + 1);
      const url = uri ? safeLink(uri) : null;
      if (url) setLink(url);
      return false;
    });
    term.open(element);
    try { fit.fit(); } catch { /* not laid out yet */ }

    const socket = new WebSocket(consoleSocketUrl());
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    let ended = false;
    const finish = (outcome: ConsoleOutcome) => {
      if (ended) return;
      ended = true;
      endRef.current(outcome);
    };
    const send = (message: AgentRuntimeConsoleClientMessage) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
    const size = () => ({ cols: clamp(term.cols, AGENT_RUNTIME_CONSOLE_SIZE.cols), rows: clamp(term.rows, AGENT_RUNTIME_CONSOLE_SIZE.rows) });
    socket.addEventListener('open', () => send({ t: 'attach', ticket, ...size() }));
    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) { term.write(new Uint8Array(event.data)); return; }
      let message: AgentRuntimeConsoleServerMessage;
      try { message = JSON.parse(String(event.data)) as AgentRuntimeConsoleServerMessage; } catch { return; }
      if (message.t === 'state') setPhase(message.state);
      else if (message.t === 'done') finish({ signedIn: message.disposition === 'accepted' && message.signedIn, ended: message.ended,
        error: message.disposition === 'superseded' ? 'superseded' : null, status: message.status });
      else finish({ signedIn: false, ended: null, error: message.code, status: null });
    });
    socket.addEventListener('close', () => finish({ signedIn: false, ended: null, error: cancelled.current ? 'cancelled' : 'ended', status: null }));
    const typed = term.onData((data) => { for (const part of chunks(data)) send({ t: 'in', d: part }); });
    let resizeTimer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try { fit.fit(); } catch { return; }
        send({ t: 'size', ...size() });
      }, 120);
    });
    observer.observe(element);
    return () => {
      ended = true;
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      typed.dispose();
      // Leaving the page ends the sign-in: the runtime stops the command when this connection closes.
      socket.close(1000, 'left');
      term.dispose();
    };
  }, [ticket]);

  function paste(event: FormEvent) {
    event.preventDefault();
    const socket = socketRef.current;
    const value = code.trim();
    if (!value || !socket || socket.readyState !== WebSocket.OPEN) return;
    for (const part of chunks(`${value}\r`)) socket.send(JSON.stringify({ t: 'in', d: part } satisfies AgentRuntimeConsoleClientMessage));
    setCode('');
  }

  const cancel = () => { cancelled.current = true; socketRef.current?.close(1000, 'cancel'); };

  return (
    <section className="nset__sec rt-console" aria-labelledby="rt-console-h">
      <h3 id="rt-console-h">{methodTitle}</h3>
      <p className="rt-phase" role="status">{phase === 'running' ? null : <Spinner />}{PHASE_TEXT[phase]}</p>
      {link ? (
        <a className="ui-btn ui-btn--primary rt-open" href={link.href} target="_blank" rel="noopener noreferrer">
          <Icon name="link" size={14} />Open the sign-in page ({link.host})
        </a>
      ) : null}
      <div className="rt-term" ref={host} aria-label="Claude Code sign-in terminal" />
      <form className="rt-code" onSubmit={paste}>
        <label htmlFor="rt-code">Paste the code from the sign-in page</label>
        <div className="rt-code__row">
          <input id="rt-code" className="ui-input" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" maxLength={2048} />
          <Button type="submit" variant="secondary" disabled={!code.trim() || phase !== 'running'}>Send</Button>
        </div>
        <p className="nset__note">On a phone: copy the code on the sign-in page, then come straight back to this page. It goes to Claude Code’s prompt and is not kept.</p>
      </form>
      <div className="aset__actions"><Button variant="quiet" onClick={cancel}>Cancel sign-in</Button></div>
    </section>
  );
}
