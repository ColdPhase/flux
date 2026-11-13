import { useState, type ReactNode } from 'react';
import { Tabs, type TabItem } from '../ui';

// Equal setup for every external MCP client (F-020 PROV-5): each gets its own add and login
// commands, and all of them get the same OAuth consent and presentation in Flux. The
// client label a person picks below is a recognition aid, not a verified identity.
//
// Commands checked 2026-10-02 against the clients' own sources:
// - Claude Code: `claude mcp add --transport http <name> <url>` and `claude mcp login <name>`, as
//   recorded with a real Claude Code 2.1.281 connection in docs/development/agent-connection.md.
// - Codex: openai/codex `codex-rs/cli/src/mcp_cmd.rs` on main
//   (https://raw.githubusercontent.com/openai/codex/main/codex-rs/cli/src/mcp_cmd.rs): usage
//   `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`; `add` starts the OAuth flow
//   itself when the server supports it, and `codex mcp login <NAME>` authenticates later. The
//   developers.openai.com Codex pages could not be reached from the implementation sandbox.

/**
 * The quick start's address (#320). The server accepts plain http only for a loopback
 * FLUX_PUBLIC_ORIGIN (localhost, 127.0.0.0/8, [::1]); any other address is https already.
 */
function isLoopbackOrigin(origin: string) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
  } catch { return false; }
}

type GuideClient = 'claude_code' | 'codex' | 'other';
const GUIDE_TABS: TabItem[] = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Another app' },
];

/** The commands behind one quiet "Show the command": the page says what to do in plain words and keeps the terminal text out of the way (#1363). */
function ShowCommand({ children, label = 'Show the command' }: { children: ReactNode; label?: string }) {
  return <details className="connection__show">
    <summary>{label}</summary>
    {children}
  </details>;
}

/**
 * One app at a time (#763 AG-2, #1363): a tab per app, each with what to do in plain words, its terminal commands behind "Show the command", and how work
 * starts in a space. Release verification notes live in docs and the CHANGELOG, never on this page (#763 AG-3).
 */
export function ClientGuide({ origin, initial = 'claude_code' }: { origin: string; initial?: GuideClient }) {
  const url = `${origin}/mcp`;
  const [client, setClient] = useState<GuideClient>(initial);
  return <div className="connection__guide">
    <h2>Connect it to Flux</h2>
    <p>Add Flux to the app you already use. It opens Flux to ask you once; allowing it is the whole setup.</p>
    {isLoopbackOrigin(origin)
      ? <p>This address works only on this computer. To connect an app on another computer, whoever runs this Flux needs to give it a secure address (https).</p>
      : null}
    <Tabs items={GUIDE_TABS} value={client} onChange={(id) => setClient(id as GuideClient)} label="Which app" panelIdPrefix="guide" className="connection__tabs" />
    {client === 'claude_code' ? <section className="connection__client" role="tabpanel" id="guide-claude_code" aria-labelledby="guide-tab-claude_code">
      <h3>Add Flux to Claude Code</h3>
      <p>Add Flux, then sign in when Claude Code asks.</p>
      <ShowCommand><code>{`claude mcp add --transport http flux ${url}\nclaude mcp login flux`}</code></ShowCommand>
      <h3>Start work</h3>
      <p>Ask Claude Code to start work in a space, and Flux supplies the instructions; you write no prompt. With one space, its name can be left out. Later, resume picks up where it left off and reads only what changed.</p>
      <ShowCommand label="Show the commands"><code>{'/mcp__flux__start_work Garden club\n/mcp__flux__resume_work'}</code></ShowCommand>
    </section> : client === 'codex' ? <section className="connection__client" role="tabpanel" id="guide-codex" aria-labelledby="guide-tab-codex">
      <h3>Add Flux to Codex</h3>
      <p>Codex starts signing in when it adds Flux; sign in again later if it asks you to.</p>
      <ShowCommand><code>{`codex mcp add flux --url ${url}\ncodex mcp login flux`}</code></ShowCommand>
      <h3>Start work</h3>
      <p>Once Flux is added, ask Codex to start work in a space. Resume continues the same Codex thread.</p>
      <p>If Codex answers “Unsupported protocol version”, update Codex.</p>
    </section> : <section className="connection__client" role="tabpanel" id="guide-other" aria-labelledby="guide-tab-other">
      <h3>Add Flux to your app</h3>
      <p>Add a remote server that uses streamable HTTP with this address. The app must support OAuth sign-in.</p>
      <code>{url}</code>
      <h3>Start work</h3>
      <p>Ask it to start work in a space in Flux.</p>
    </section>}
    <p>It uses your own account with the app’s provider, and Flux receives no credentials. It can do only what you can, and only as far as its “What it may do” allows. Deleting anything and other people’s things wait for your OK.</p>
  </div>;
}
