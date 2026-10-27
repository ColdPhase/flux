import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AI_PROVIDERS, assistantCanSentence, assistantSettingsPath, type AiProviderKind, type AssistantRun, type AssistantSettings } from '@flux/contracts';
import { request } from '../api/client';
import { AgentTag, Button, Icon, Kreska, MEDIA, Overlay, agentHue, useMediaQuery, usePop } from '../ui';
import { getAssistantStatus, listOwnRuns, pauseAssistant, resumeAssistant, stopRun } from './api';
import { AssistantModelControl } from './ModelPicker';

// The assistant's panel (F-027 AST-10 Journey 3): tap its name on any message. Now, Recent, Can and Message for its
// owner; for everyone else one line about who pays and where what it reads goes. "Pause my assistant" is on the panel
// itself, so pausing is two taps from the message.

/** The AI company of a provider, in the words a person knows. */
export const companyName = (provider: AiProviderKind) => (provider === 'anthropic' ? 'Claude' : AI_PROVIDERS[provider].label);
const dataTo = (provider: AiProviderKind) => AI_PROVIDERS[provider].label;

const WORKING = new Set<AssistantRun['status']>(['queued', 'reading', 'dispatching']);
const RECENT_WORD: Partial<Record<AssistantRun['status'], string>> = {
  completed: 'Done', truncated: 'Done, cut short', stopped: 'Stopped', denied: 'Refused', paused: 'Paused', cap_reached: 'Stopped at the limit', unavailable: 'Couldn\'t run', revoked: 'Stopped',
};

export function AssistantPanel({ open, onClose, name, mine, ownerName, provider, userId, onMessage }: {
  open: boolean; onClose: () => void; name: string; mine: boolean; ownerName: string; provider: AiProviderKind;
  userId: string; onMessage: (() => void) | null;
}) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label={name} className="aset-panel">
      {open ? <Body onClose={onClose} name={name} mine={mine} ownerName={ownerName} provider={provider} userId={userId} onMessage={onMessage} /> : null}
    </Overlay>
  );
}

function Body({ onClose, name, mine, ownerName, provider, userId, onMessage }: {
  onClose: () => void; name: string; mine: boolean; ownerName: string; provider: AiProviderKind; userId: string; onMessage: (() => void) | null;
}) {
  const [runs, setRuns] = useState<AssistantRun[] | null>(null);
  const [can, setCan] = useState('');
  const [paused, setPaused] = useState<boolean | null>(null);
  const [menu, setMenu] = useState(false);
  const pop = usePop(menu);
  const [error, setError] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mine) return undefined;
    const controller = new AbortController();
    listOwnRuns(controller.signal).then((page) => setRuns(page.items), () => setRuns([]));
    getAssistantStatus(controller.signal).then(async (status) => {
      setPaused(status.state === 'paused');
      const workspaceId = status.enablement?.agents[0]?.workspaceId;
      if (!workspaceId) return;
      const settings = await request<AssistantSettings>(assistantSettingsPath(workspaceId, userId), { signal: controller.signal });
      setCan(assistantCanSentence(settings.areas, settings.approvalMode));
    }).catch(() => setPaused((current) => current ?? false));
    return () => controller.abort();
  }, [mine, userId]);
  useEffect(() => { first.current?.focus(); }, []);
  const working = runs?.find((run) => WORKING.has(run.status)) ?? null;
  const recent = (runs ?? []).filter((run) => !WORKING.has(run.status)).slice(0, 4);
  const toggle = async () => {
    setError('');
    try { const next = await (paused ? resumeAssistant() : pauseAssistant()); setPaused(next.state === 'paused'); }
    catch { setError('Couldn\'t change that. Try again.'); }
  };
  return (
    <div className="aset-panel__in" role="group" aria-label={`${name}, details`}>
      <header className="aset-panel__head">
        <Kreska size={28} hue={agentHue(`assistant:${userId}`)} />
        <div><strong>{name}</strong> <AgentTag /><span className="aset-panel__sub">for {mine ? 'you' : ownerName} · in Flux · {companyName(provider)}</span></div>
        {mine ? <div className="aset-panel__menu">
          <Button variant="quiet" aria-label="More" aria-haspopup="menu" aria-expanded={menu} disabled={paused === null} onClick={() => setMenu(!menu)}><Icon name="more" size={16} /></Button>
          {pop.mounted ? <div {...pop.props} className="aset-panel__pop" role="menu">
            <Button variant="quiet" role="menuitem" onClick={() => { setMenu(false); void toggle(); }}>{paused ? 'Resume my assistant' : 'Pause my assistant'}</Button>
            <Link className="ui-link" role="menuitem" to="/settings/assistant" onClick={onClose}>Manage <Icon name="chevron-right" size={12} /></Link>
          </div> : null}
        </div> : null}
        <Button ref={first} variant="quiet" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></Button>
      </header>
      {mine && paused === null ? <p aria-busy="true">Loading…</p> : mine ? <>
        <section aria-labelledby="aset-panel-now"><h3 id="aset-panel-now">Now</h3>
          {working ? <p>Working… <Button variant="secondary" onClick={() => void stopRun(working.id).catch(() => setError('Offline'))}>Stop</Button></p>
            : <p>{paused ? 'Paused. Nothing runs until you resume.' : 'Idle.'}</p>}
        </section>
        <section aria-labelledby="aset-panel-recent"><h3 id="aset-panel-recent">Recent</h3>
          {runs === null ? <p>Loading…</p> : recent.length ? <ul className="aset-panel__recent">{recent.map((run) => (
            <li key={run.id}><span>{RECENT_WORD[run.status] ?? 'Done'}: {run.prompt.length > 60 ? `${run.prompt.slice(0, 59)}…` : run.prompt}</span></li>))}</ul> : <p>Nothing yet.</p>}
        </section>
        <section aria-labelledby="aset-panel-can"><h3 id="aset-panel-can">Can</h3><p data-testid="assistant-can">{can || 'Loading…'}</p></section>
        <div className="aset-model-row"><AssistantModelControl variant="field" placement="up" /></div>
      </> : <p data-testid="assistant-others">Uses {companyName(provider)} through {ownerName}&apos;s account. What it reads here goes to {dataTo(provider)}.</p>}
      {error ? <p role="alert" className="nset__error">{error}</p> : null}
      <footer className="aset-panel__foot">
        {mine && onMessage && paused !== null ? <Button variant="primary" onClick={() => { onClose(); onMessage(); }}>Message</Button> : null}
      </footer>
    </div>
  );
}
