import { useState } from 'react';
import { Link } from 'react-router';
import { AGENT_MAY_DO_LABELS, type AgentConnection } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon } from '../ui';
import { revokeAgentConnection } from './api';
import '../my-agents/my-agents.css';
import './connection.css';

/**
 * The person's own Claude Code or Codex, one row each in Settings › AI's Connect AI card (F-026 §7 Agents and AI, #1363): the terminal mark in
 * the icon tile the connections have (as `desktop-settings-ai` draws it), "Claude Code on this computer", "For code on your computer. Same rules as your agents.", its "What it may do" tag (a link to the page
 * where it is changed) and Disconnect. Disconnect asks in the row, in one line, and stops the client's access at once.
 */
export function ClientRows({ connections, onDisconnected }: { connections: AgentConnection[]; onDisconnected: (connectionId: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function disconnect(connectionId: string) {
    setBusy(true); setError('');
    try { await revokeAgentConnection(connectionId); setConfirming(null); onDisconnected(connectionId); }
    catch (cause) { setError(cause instanceof ApiError && cause.status < 500 && cause.message ? cause.message : 'Couldn’t disconnect it. Try again.'); }
    finally { setBusy(false); }
  }

  return <>{connections.map((connection) => (
    <li key={connection.id} className="sset-row cai__row client-row" data-client={connection.id}>
      <span className="sset-row__ic" aria-hidden="true"><Icon name="terminal" size={16} /></span>
      <span className="sset-row__b">
        <span className="sset-row__t">{connection.name}</span>
        <span className="sset-row__s">For code on your computer. Same rules as your agents.</span>
        {confirming === connection.id ? (
          <span className="client-row__confirm" role="group" aria-label={`Disconnect ${connection.name}`}>
            <span>Disconnect now? Its access stops at once and what it had waiting is dropped.</span>
            <Button variant="secondary" size="sm" busy={busy} onClick={() => { void disconnect(connection.id); }}>Disconnect</Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => { setConfirming(null); setError(''); }}>Cancel</Button>
          </span>
        ) : null}
        {confirming === connection.id && error ? <span className="client-row__error" role="alert"><Icon name="alert" size={14} />{error}</span> : null}
      </span>
      <Link className="agl__may client-row__may" to="/settings/agents/connect" aria-label={`What ${connection.name} may do: ${AGENT_MAY_DO_LABELS[connection.mayDo]}. Change it`}>{AGENT_MAY_DO_LABELS[connection.mayDo]}</Link>
      {confirming === connection.id ? null : <Button variant="quiet" size="sm" className="cai__change" aria-label={`Disconnect ${connection.name}`} onClick={() => { setConfirming(connection.id); setError(''); }}>Disconnect</Button>}
    </li>
  ))}</>;
}
