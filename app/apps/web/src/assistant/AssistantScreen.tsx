import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AGENT_ALWAYS_WAITS, aiConnectionLabel, assistantSettingsPath, type AssistantSettings, type PersonalAssistantStatus } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { AgentTag, Icon, Kreska, agentHue } from '../ui';
import { runtimeNames } from './format';
import { AssistantModelControl } from './ModelPicker';
import { MayDoChoice } from '../agent-connection/MayDoChoice';

// The assistant screen (F-036 AG-3): a header with the one switch that stops everything, the account row (who pays), and
// one "What it may do" row. Every control saves as it is touched and reads back what the server kept, so the screen never
// shows a setting that is not in force. Undo sits on the agent's own messages; there is no Activity list here.

export function AssistantHeader({ name, userId, status, busy, onToggle }: {
  name: string; userId: string; status: PersonalAssistantStatus; busy: boolean; onToggle: (on: boolean) => void;
}) {
  const first = name.trim().split(/\s+/)[0] || name;
  const on = status.state !== 'paused';
  const runtime = status.enablement?.engine === 'runtime';
  const consent = status.enablement?.consent;
  const names = runtimeNames(status.setup.runtime?.client);
  return (
    <section className="sset-card aset-screen__head" aria-labelledby="aset-title">
      <div className="sset-row">
        <span className="sset-row__ic" aria-hidden="true"><Kreska size={28} hue={agentHue(`assistant:${userId}`)} /></span>
        <div className="sset-row__b">
          <h2 className="sset-row__t" id="aset-title"><span className="sset-row__identity">{first}&apos;s assistant <AgentTag /></span></h2>
          <span className="sset-row__s">for you · in Flux</span>
        </div>
        <button type="button" role="switch" className="sset-switch" aria-checked={on} aria-label="Your assistant is on" disabled={busy} onClick={() => onToggle(!on)}><span aria-hidden="true" /></button>
      </div>
      <div className="sset-row aset-screen__account">
        <div className="sset-row__b">
          <span className="sset-row__t">{runtime ? `${names.plan} · your subscription` : consent ? `${aiConnectionLabel(consent.provider, consent.model)} · your API key` : 'Your AI account'}</span>
          <span className="aset-model-row"><AssistantModelControl variant="field" /></span>
          {runtime ? <span className="sset-row__s">Flux can&apos;t see your plan&apos;s limits.</span> : null}
        </div>
        <Link className="ui-link aset-screen__change" to="/settings/agents">Change <Icon name="chevron-right" size={12} /></Link>
      </div>
    </section>
  );
}

/** "What it may do" (F-036 AG-3): Only read, Do it and tell me (the default) or Ask me first, saved on the assistant's connection. */
export function AssistantControls({ status, userId }: { status: PersonalAssistantStatus; userId: string }) {
  const workspaceId = status.enablement?.agents[0]?.workspaceId ?? null;
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [error, setError] = useState('');
  const path = workspaceId ? assistantSettingsPath(workspaceId, userId) : null;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    request<AssistantSettings>(path, { signal: controller.signal }).then(setSettings, (cause) => { if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'This couldn\'t load.'); });
    return () => controller.abort();
  }, [path]);
  if (!path) return null;
  if (!settings) return error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null;

  return (
    <>
      <h3 className="aset-screen__h" id="aset-can">What it may do</h3>
      <section className="sset-card" aria-labelledby="aset-can">
        <div className="sset-row aset-screen__approval">
          <div className="sset-row__b">
            <MayDoChoice connectionId={settings.connectionId} initial={settings.mayDo} labelledBy="aset-can" />
          </div>
        </div>
      </section>
      <p className="nset__note aset-screen__can" data-testid="assistant-can">{AGENT_ALWAYS_WAITS}</p>
    </>
  );
}
