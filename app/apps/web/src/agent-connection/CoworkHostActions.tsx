import './host-actions.css';

/** Supplied host invocation: the browser cannot start a closed native application. */
export function CoworkHostActions({ connectionId, projectId, client }: { connectionId: string; projectId: string; client: string }) {
  // Claude Code's supplied actions are the server's own MCP prompts (#160 AC-2), verified with a real account 2026-10-30.
  if (client === 'claude_code') return <details className="cowork-host-actions">
    <summary>Start / Resume in Claude Code</summary>
    <p>Start</p><code>/mcp__flux__start_work {projectId}</code>
    <p>Resume</p><code>/mcp__flux__resume_work {projectId}</code>
    <p>Flux supplies the instructions; you write no prompt. Flux permissions still apply. Stop ends its Flux hold; Claude Code may keep running.</p>
  </details>;
  if (client !== 'codex') return <p>Supplied Start/Resume for this client is pending native workflow verification.</p>;
  const origin = window.location.origin;
  const args = `--client codex --origin ${origin} --connection ${connectionId} --project ${projectId}`;
  return <details className="cowork-host-actions">
    <summary>Start / Resume on this computer</summary>
    <p>Verified with a real Codex 0.160.1 account on 30 October 2026: Start created the planned task, and Resume continued the same thread, found the changed plan and recorded a result. Run it from your Flux checkout; it needs its built Docker image and Codex already signed in with ChatGPT. Your browser cannot launch a closed client.</p>
    <p>Start</p><code>./flux cowork start {args}</code>
    <p>Resume the same project and native thread</p><code>./flux cowork resume {args}</code>
    <p>Resume from the same directory. Flux permissions still apply. An open session does not prove that the client is working. Stop ends its Flux hold; its native app may keep running.</p>
  </details>;
}
