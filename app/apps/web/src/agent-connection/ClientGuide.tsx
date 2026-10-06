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

export function ClientGuide({ origin }: { origin: string }) {
  const url = `${origin}/mcp`;
  return <div className="connection__guide">
    <h2>Connect your MCP client</h2>
    <p>Add this Flux address to the client you already use. Each client opens this page to ask for your consent, and each gets exactly the same access you approve here.</p>
    {isLoopbackOrigin(origin)
      ? <p>This address works only on this computer. A client on another computer needs an HTTPS address for this Flux server, which its operator sets up.</p>
      : null}
    <section className="connection__client" aria-labelledby="guide-claude-code">
      <h3 id="guide-claude-code">Claude Code</h3>
      <code>claude mcp add --transport http flux {url}</code>
      <code>claude mcp login flux</code>
    </section>
    <section className="connection__client" aria-labelledby="guide-codex">
      <h3 id="guide-codex">Codex</h3>
      <code>codex mcp add flux --url {url}</code>
      <code>codex mcp login flux</code>
      <p>Codex starts signing in when it adds the server; run the login command if it asks you to.</p>
    </section>
    <section className="connection__client" aria-labelledby="guide-other">
      <h3 id="guide-other">Another MCP client</h3>
      <p>Add a remote MCP server that uses streamable HTTP with this address. The client must support OAuth sign-in.</p>
      <code>{url}</code>
    </section>
    <p>Use your own client account for compute. Flux receives no provider credentials. A connection can do only what you allow on this page: read the selected projects, suggest next steps for review, and run only the actions you grant.</p>
  </div>;
}
