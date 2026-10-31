import { useState } from 'react';
import { Icon } from '../ui';
import './host-actions.css';

/** A command with a Copy button for the whole of it (#763 WF-6): nobody retypes a project id. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="cowork-host-actions__cmd">
    <code>{text}</code>
    <button type="button" className="cowork-host-actions__copy" aria-label={`Copy ${text}`}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => undefined); }}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>;
}

const Summary = ({ children }: { children: string }) => <summary><Icon name="chevron-down" size={14} />{children}</summary>;

/**
 * Supplied host invocation: the browser cannot start a closed native application. The words are for the person who uses the
 * client (#763 AG-3): release verification notes stay in docs and the CHANGELOG.
 */
export function CoworkHostActions({ connectionId, projectId, client }: { connectionId: string; projectId: string; client: string }) {
  // Claude Code's supplied actions are the server's own MCP prompts (#160 AC-2).
  if (client === 'claude_code') return <details className="cowork-host-actions">
    <Summary>Start / Resume in Claude Code</Summary>
    <p>Start</p><Command text={`/mcp__flux__start_work ${projectId}`} />
    <p>Resume</p><Command text={`/mcp__flux__resume_work ${projectId}`} />
    <p>Flux supplies the instructions; you write no prompt. Flux permissions still apply. Stop ends its Flux hold; Claude Code may keep running.</p>
  </details>;
  if (client !== 'codex') return <p className="cowork-host-actions__note">Start it from your client: ask it to start work on this project in Flux.</p>;
  const origin = window.location.origin;
  const args = `--client codex --origin ${origin} --connection ${connectionId} --project ${projectId}`;
  // The supplied Codex action is the Flux launcher's `cowork` command (docs/development/cowork-coordination.md): it runs in
  // the folder where Flux was installed, on the computer whose Codex is signed in.
  return <details className="cowork-host-actions">
    <Summary>Start / Resume in Codex</Summary>
    <p>Run these in the folder where Flux was installed (the one with <code className="cowork-host-actions__inline">./flux</code>), on the computer where Codex is signed in. Your browser cannot open Codex for you.</p>
    <p>Start</p><Command text={`./flux cowork start ${args}`} />
    <p>Resume</p><Command text={`./flux cowork resume ${args}`} />
    <p>Resume continues the same Codex thread; run it from the same folder. Flux permissions still apply. Stop ends its Flux hold; Codex may keep running.</p>
  </details>;
}
