import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { ASSISTANT_AREAS, aiConnectionLabel, assistantCanSentence, assistantSettingsPath, type AssistantAreaId, type AssistantSettings, type PersonalAssistantStatus, type UpdateAssistantSettings } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { SwitchRow } from '../app/SettingsHome';
import { AgentTag, Icon, Kreska, agentHue } from '../ui';
import { runtimeNames } from './format';

// The assistant screen (F-027 AST-10, A7): a header with the one switch that stops everything, the account row
// (who pays), "When it changes something", and the five switches. Every control saves as it is touched and
// reads back what the server kept, so the screen never shows a setting that is not in force.

const APPROVAL = [
  { id: 'act', label: 'Do it and tell me' },
  { id: 'ask', label: 'Ask me first' },
] as const;

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
          {runtime ? <span className="sset-row__s">Flux can&apos;t see your plan&apos;s limits.</span> : null}
        </div>
        <Link className="ui-link aset-screen__change" to="/settings/agents">Change <Icon name="chevron-right" size={12} /></Link>
      </div>
    </section>
  );
}

export function AssistantControls({ status, userId }: { status: PersonalAssistantStatus; userId: string }) {
  const workspaceId = status.enablement?.agents[0]?.workspaceId ?? null;
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const path = workspaceId ? assistantSettingsPath(workspaceId, userId) : null;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    request<AssistantSettings>(path, { signal: controller.signal }).then(setSettings, (cause) => { if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'The switches couldn\'t load.'); });
    return () => controller.abort();
  }, [path]);
  const group = useRef<HTMLDivElement>(null);
  if (!path) return null;
  if (!settings) return error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null;

  const save = async (patch: UpdateAssistantSettings) => {
    setSaving(true); setError('');
    try { setSettings(await request<AssistantSettings>(path, { method: 'PATCH', body: { ...patch, expectedVersion: settings.version } })); }
    catch (cause) {
      setError('Couldn\'t save. The latest settings are shown.');
      try { setSettings(await request<AssistantSettings>(path)); } catch { /* keep what is shown */ }
      void cause;
    } finally { setSaving(false); }
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = APPROVAL[(APPROVAL.findIndex((item) => item.id === settings.approvalMode) + delta + APPROVAL.length) % APPROVAL.length]!;
    void save({ approvalMode: next.id }).then(() => group.current?.querySelector<HTMLElement>(`[data-approval="${next.id}"]`)?.focus());
  };
  return (
    <>
      <h3 className="aset-screen__h" id="aset-can">What it can do</h3>
      <section className="sset-card" aria-labelledby="aset-can">
        <div className="sset-row aset-screen__approval">
          <div className="sset-row__b">
            <span className="sset-row__t" id="aset-approval">When it changes something</span>
            <div ref={group} className="seg aset-screen__seg" role="radiogroup" aria-labelledby="aset-approval" onKeyDown={move}>
              {APPROVAL.map((item) => (
                <button key={item.id} type="button" role="radio" className="seg__b" data-approval={item.id} aria-checked={settings.approvalMode === item.id}
                  tabIndex={settings.approvalMode === item.id ? 0 : -1} onClick={() => { if (settings.approvalMode !== item.id) void save({ approvalMode: item.id }); }}>{item.label}</button>
              ))}
            </div>
            <span className="sset-row__s">It asks before removing anything or changing things other people made or are responsible for.</span>
          </div>
        </div>
        {ASSISTANT_AREAS.map((area) => (
          <SwitchRow key={area.id} label={area.label} checked={settings.areas[area.id as AssistantAreaId] === 'edit'} disabled={saving}
            detail={settings.areas[area.id as AssistantAreaId] === 'read' ? 'Only reads for now' : undefined}
            onChange={(on) => void save({ areas: { [area.id]: on ? 'edit' : 'off' } })} />
        ))}
      </section>
      <p className="nset__note aset-screen__can" data-testid="assistant-can">{assistantCanSentence(settings.areas, settings.approvalMode)}</p>
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </>
  );
}
