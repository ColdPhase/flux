import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AGENT_ALWAYS_WAITS, AGENT_MAY_DO_LABELS, AI_PROVIDERS, type AiProviderKind, type AssistantRun } from '@flux/contracts';
import { useShellData } from '../app/data';
import { AgentTag, Button, Icon, Kreska, MEDIA, Overlay, useMediaQuery } from '../ui';
import { listOwnRuns, stopRun } from './api';
import { AssistantModelControl } from './ModelPicker';

// The assistant's panel (F-027 AST-10 Journey 3, F-036): tap its name on any message. Now, Recent, What it may do and Message for
// its owner; for everyone else one line about who pays and where what it reads goes. Its settings are its page in Settings › AI.

/** The AI company of a provider, in the words a person knows. */
export const companyName = (provider: AiProviderKind) => (provider === 'anthropic' ? 'Claude' : AI_PROVIDERS[provider].label);
const dataTo = (provider: AiProviderKind) => AI_PROVIDERS[provider].label;

const WORKING = new Set<AssistantRun['status']>(['queued', 'reading', 'dispatching']);
const RECENT_WORD: Partial<Record<AssistantRun['status'], string>> = {
  completed: 'Done', truncated: 'Done, cut short', stopped: 'Stopped', denied: 'Refused', paused: 'Paused', cap_reached: 'Stopped at the limit', unavailable: 'Couldn\'t run', revoked: 'Stopped',
};

export function AssistantPanel({ open, onClose, name, mine, ownerName, provider, onMessage }: {
  open: boolean; onClose: () => void; name: string; mine: boolean; ownerName: string; provider: AiProviderKind;
  onMessage: (() => void) | null;
}) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label={name} className="aset-panel">
      {open ? <Body onClose={onClose} name={name} mine={mine} ownerName={ownerName} provider={provider} onMessage={onMessage} /> : null}
    </Overlay>
  );
}

function Body({ onClose, name, mine, ownerName, provider, onMessage }: {
  onClose: () => void; name: string; mine: boolean; ownerName: string; provider: AiProviderKind; onMessage: (() => void) | null;
}) {
  const { agents } = useShellData();
  // The asker's first agent is the one that answers `/ai` (F-036 AG-1).
  const agent = agents[0] ?? null;
  const [runs, setRuns] = useState<AssistantRun[] | null>(null);
  const [error, setError] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mine) return undefined;
    const controller = new AbortController();
    listOwnRuns(controller.signal).then((page) => setRuns(page.items), () => setRuns([]));
    return () => controller.abort();
  }, [mine]);
  useEffect(() => { first.current?.focus(); }, []);
  const working = runs?.find((run) => WORKING.has(run.status)) ?? null;
  const recent = (runs ?? []).filter((run) => !WORKING.has(run.status)).slice(0, 4);
  const can = agent ? `${AGENT_MAY_DO_LABELS[agent.mayDo]}. ${AGENT_ALWAYS_WAITS}` : '';
  return (
    <div className="aset-panel__in" role="group" aria-label={`${name}, details`}>
      <header className="aset-panel__head">
        <Kreska size={28} {...(agent ? { hue: agent.colour } : {})} />
        <div><strong>{name}</strong> <AgentTag /><span className="aset-panel__sub">for {mine ? 'you' : ownerName} · in Flux · {companyName(provider)}</span></div>
        {mine && agent ? <Link className="ui-link aset-panel__manage" to={`/settings/agents/${agent.id}`} onClick={onClose}>Manage <Icon name="chevron-right" size={12} /></Link> : null}
        <Button ref={first} variant="quiet" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></Button>
      </header>
      {mine ? <>
        <section aria-labelledby="aset-panel-now"><h3 id="aset-panel-now">Now</h3>
          {working ? <p>Working… <Button variant="secondary" onClick={() => void stopRun(working.id).catch(() => setError('Offline'))}>Stop</Button></p> : <p>Idle.</p>}
        </section>
        <section aria-labelledby="aset-panel-recent"><h3 id="aset-panel-recent">Recent</h3>
          {runs === null ? <p>Loading…</p> : recent.length ? <ul className="aset-panel__recent">{recent.map((run) => (
            <li key={run.id}><span>{run.endReason === 'ai_off' ? 'Stopped, AI was turned off' : RECENT_WORD[run.status] ?? 'Done'}: {run.prompt.length > 60 ? `${run.prompt.slice(0, 59)}…` : run.prompt}</span></li>))}</ul> : <p>Nothing yet.</p>}
        </section>
        <section aria-labelledby="aset-panel-can"><h3 id="aset-panel-can">What it may do</h3><p data-testid="assistant-can">{can || 'Loading…'}</p></section>
        <div className="aset-model-row"><AssistantModelControl variant="field" placement="up" /></div>
      </> : <p data-testid="assistant-others">Uses {companyName(provider)} through {ownerName}&apos;s account. What it reads here goes to {dataTo(provider)}.</p>}
      {error ? <p role="alert" className="nset__error">{error}</p> : null}
      <footer className="aset-panel__foot">
        {mine && onMessage ? <Button variant="primary" onClick={() => { onClose(); onMessage(); }}>Message</Button> : null}
      </footer>
    </div>
  );
}
