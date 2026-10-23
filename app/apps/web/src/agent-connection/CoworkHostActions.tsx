import './host-actions.css';

/** Supplied host invocation: the browser cannot start a closed native application. */
export function CoworkHostActions({ connectionId, projectId, client }: { connectionId: string; projectId: string; client: string }) {
  if (client !== 'codex') return <p>Supplied Start/Resume for this client is pending native workflow verification.</p>;
  const origin = window.location.origin;
  const args = `--client codex --origin ${origin} --connection ${connectionId} --project ${projectId}`;
  return <details className="cowork-host-actions">
    <summary>Start / Resume on this computer (pending native verification)</summary>
    <p>Pending native verification: no real-account Start or exact-thread Resume is recorded yet. Run the supplied action from your Flux checkout only if you accept that. It needs its built Docker image and Codex 0.160.1 already signed in with ChatGPT. Your browser cannot launch a closed client.</p>
    <p>Start</p><code>./flux cowork start {args}</code>
    <p>Resume the same project and native thread (unverified)</p><code>./flux cowork resume {args}</code>
    <p>Resume from the same directory. Flux permissions still apply. An open session does not prove that the client is working. Stop ends its Flux hold; its native app may keep running.</p>
  </details>;
}
