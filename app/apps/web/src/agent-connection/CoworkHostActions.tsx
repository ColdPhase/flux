import './host-actions.css';

/**
 * Supplied host invocation: the browser cannot start a closed native application. The words are for the person who uses the
 * client (#763 AG-3): release verification notes stay in docs and the CHANGELOG.
 */
export function CoworkHostActions({ connectionId, projectId, client }: { connectionId: string; projectId: string; client: string }) {
  // Claude Code's supplied actions are the server's own MCP prompts (#160 AC-2).
  if (client === 'claude_code') return <details className="cowork-host-actions">
    <summary>Start / Resume in Claude Code</summary>
    <p>Start</p><code>/mcp__flux__start_work {projectId}</code>
    <p>Resume</p><code>/mcp__flux__resume_work {projectId}</code>
    <p>Flux supplies the instructions; you write no prompt. Flux permissions still apply. Stop ends its Flux hold; Claude Code may keep running.</p>
  </details>;
  if (client !== 'codex') return <p className="cowork-host-actions__note">Start it from your client: ask it to start work on this project in Flux.</p>;
  const origin = window.location.origin;
  const args = `--client codex --origin ${origin} --connection ${connectionId} --project ${projectId}`;
  // The supplied Codex action is the Flux launcher's `cowork` command (docs/development/cowork-coordination.md): it runs in
  // the folder where Flux was installed, on the computer whose Codex is signed in.
  return <details className="cowork-host-actions">
    <summary>Start / Resume in Codex</summary>
    <p>Run these in the folder where Flux was installed (the one with <code className="cowork-host-actions__inline">./flux</code>), on the computer where Codex is signed in. Your browser cannot open Codex for you.</p>
    <p>Start</p><code>./flux cowork start {args}</code>
    <p>Resume</p><code>./flux cowork resume {args}</code>
    <p>Resume continues the same Codex thread; run it from the same folder. Flux permissions still apply. Stop ends its Flux hold; Codex may keep running.</p>
  </details>;
}
