import { useCallback, useEffect, useState } from 'react';
import { Link, useRevalidator } from 'react-router';
import type { AgentRuntimeStatus, BackgroundComputeConnection } from '@flux/contracts';
import { getRuntime } from '../agent-runtime/api';
import { Button, Icon, Spinner } from '../ui';
import { refreshAssistantModel } from '../assistant/model';
import { connectionLines, type AiConnectionKind, type AiConnectionLine } from './connections';
import { ConnectAiWindow } from './ConnectAiWindow';
import './connect-ai.css';

// Settings › AI › Connect AI (#854, mockups Main and ConnectAI): one place where a person connects AI, once, with as many
// connections as they like: a Claude plan, a ChatGPT plan and API keys side by side. Each connection is one row: its name
// and state, one line with the provider's remaining usage (or the key's daily budget), and "Change" on the right. Flux adds
// no limits of its own. "Connect another" opens the one window in steps that makes a new connection.

const ICON: Record<AiConnectionKind, 'spark' | 'chat' | 'key'> = { claude_plan: 'spark', chatgpt_plan: 'chat', api_key: 'key' };

function UsageBar({ used }: { used: number | null }) {
  if (used === null) return null;
  return <span className="cai__bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, 100 - used))}%` }} /></span>;
}

function ConnectionRow({ line }: { line: AiConnectionLine }) {
  return (
    <li className="sset-row cai__row" data-connection={line.kind}>
      <span className="sset-row__ic" aria-hidden="true"><Icon name={ICON[line.kind]} size={16} /></span>
      <span className="sset-row__b">
        <span className="sset-row__t">{line.name}<span className="cai__state"> · {line.state === 'connected' ? 'Connected' : 'Sign in again'}</span></span>
        <span className="cai__usage"><UsageBar used={line.used} /><span className="cai__usage-text">{line.usage}</span></span>
      </span>
      <Link className="ui-btn ui-btn--secondary cai__change" to={line.to} aria-label={`Change ${line.name}`}>Change</Link>
    </li>
  );
}

/**
 * `apiKeys`: whether this Flux runs agents on API keys at all (the operator's switch); a key is only offered then. `keys`: the
 * person's own API keys, null while they load (the page reads them once, also to tell whether the server runs any AI).
 */
export function ConnectAi({ apiKeys, keys, keysFailed, onRetryKeys, onListed }: {
  apiKeys: boolean; keys: BackgroundComputeConnection[] | null; keysFailed: boolean; onRetryKeys: () => void;
  /** Whether any connection is listed, usable or not, for Your agents to say what waits for it (#1173). */
  onListed?: (listed: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<AgentRuntimeStatus | null>(null);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const revalidator = useRevalidator();
  const loadRuntime = useCallback((signal?: AbortSignal) => {
    getRuntime(signal).then((next) => { setRuntime(next); setRuntimeFailed(false); }, () => { if (!signal?.aborted) { setRuntime(null); setRuntimeFailed(true); } });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadRuntime(controller.signal);
    return () => controller.abort();
  }, [loadRuntime]);
  const lines = keys === null ? [] : connectionLines(runtime, keys);
  const have = new Set(lines.map((line) => line.kind));
  const listed = lines.length > 0;
  useEffect(() => { onListed?.(listed); }, [onListed, listed]);
  return (
    <section className="cai" aria-labelledby="connect-ai" aria-busy={keys === null || undefined}>
      <div className="cai__head">
        <div className="cai__title">
          <h3 className="sset-sub cai__h" id="connect-ai">Connect AI</h3>
          <span className="cai__lead">Plans can run side by side. Each agent uses one.</span>
        </div>
        {lines.length ? <Button variant="secondary" icon="plus" onClick={() => setWindowOpen(true)}>Connect another</Button> : null}
      </div>
      {keys === null ? <p className="sset-note"><Spinner label="Loading your connections" /></p> : null}
      {lines.length ? <ul className="sset-card cai__list">{lines.map((line) => <ConnectionRow key={line.id} line={line} />)}</ul> : null}
      {keysFailed ? <p className="sset-note" role="note">Your API keys could not be listed. <button type="button" className="ui-link" onClick={onRetryKeys}>Try again</button></p> : null}
      {runtimeFailed ? <p className="sset-note" role="note">Your plans could not be read. <button type="button" className="ui-link" onClick={() => loadRuntime()}>Try again</button></p> : null}
      {keys !== null && !lines.length ? (
        <div className="sset-card cai__empty">
          <span className="cai__choose-lead">Nothing is connected yet.</span>
          <Button variant="primary" onClick={() => setWindowOpen(true)}>Connect AI</Button>
        </div>
      ) : null}
      {windowOpen ? <ConnectAiWindow runtime={runtime} runtimeFailed={runtimeFailed} apiKeys={apiKeys} have={have} onClose={() => setWindowOpen(false)}
        onConnected={() => {
          setWindowOpen(false); loadRuntime(); onRetryKeys();
          // The first connection gives a person their Assistant on the server, so the shell's agents and the models are read again.
          void revalidator.revalidate(); void refreshAssistantModel();
        }} /> : null}
    </section>
  );
}
