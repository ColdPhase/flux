import { useState } from 'react';
import { Tabs, type TabItem } from '../ui';

// Equal setup for every external MCP client (F-020 PROV-5): each gets its own add and login
// commands, and all of them get the same OAuth consent, grants and presentation in Flux. The
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
  { id: 'other', label: 'Other client' },
];

/**
 * One client at a time (#763 AG-2): a tab per client, each with its own add and login commands and how work starts. Release
 * verification notes live in docs and the CHANGELOG, never on this page (#763 AG-3).
 */
export function ClientGuide({ origin, initial = 'claude_code' }: { origin: string; initial?: GuideClient }) {
  const url = `${origin}/mcp`;
  const [client, setClient] = useState<GuideClient>(initial);
  return <div className="connection__guide">
    <h2>Connect your MCP client</h2>
    <p>Add this Flux address to the client you already use. It opens Flux to ask for your consent, and gets only the access you approve.</p>
    {isLoopbackOrigin(origin)
      ? <p>This address works only on this computer. A client on another computer needs an HTTPS address for this Flux server, which its operator sets up.</p>
      : null}
    <Tabs items={GUIDE_TABS} value={client} onChange={(id) => setClient(id as GuideClient)} label="Your client" panelIdPrefix="guide" className="connection__tabs" />
    {client === 'claude_code' ? <section className="connection__client" role="tabpanel" id="guide-claude_code" aria-labelledby="guide-tab-claude_code">
      <code>{`claude mcp add --transport http flux ${url}\nclaude mcp login flux`}</code>
      <h3>Start work</h3>
      <p>In Claude Code, type <code>/mcp__flux__start_work</code> and choose your project. Later, <code>/mcp__flux__resume_work</code> picks up where it left off and reads only what changed. Flux supplies the instructions; you write no prompt.</p>
    </section> : client === 'codex' ? <section className="connection__client" role="tabpanel" id="guide-codex" aria-labelledby="guide-tab-codex">
      <code>{`codex mcp add flux --url ${url}\ncodex mcp login flux`}</code>
      <p>Codex starts signing in when it adds the server; run the login command if it asks you to.</p>
      <h3>Start work</h3>
      <p>Once your connection is saved, its Start and Resume commands appear with it below and on the project’s Agents view. Resume continues the same Codex thread.</p>
      <p>If Codex answers “Unsupported protocol version”, update Codex.</p>
    </section> : <section className="connection__client" role="tabpanel" id="guide-other" aria-labelledby="guide-tab-other">
      <p>Add a remote MCP server that uses streamable HTTP with this address. The client must support OAuth sign-in.</p>
      <code>{url}</code>
      <h3>Start work</h3>
      <p>Start it from your client: ask it to start work on your project in Flux.</p>
    </section>}
    <p>Use your own client account for compute. Flux receives no provider credentials. A connection can do only what you allow on this page: read the selected projects, suggest next steps for review, and run only the actions you grant.</p>
  </div>;
}
