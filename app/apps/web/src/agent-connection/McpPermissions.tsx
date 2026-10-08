import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AGENT_MCP_ENTRIES, AGENT_MCP_READ_CAPABILITIES, type AgentConnection, type AgentMcpCapabilityId,
  type SaveAgentMcpPolicy } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button } from '../ui';
import { getMcpPermissions, saveMcpPermissions, type McpPermissionSettings } from './api';

const LABEL: Partial<Record<AgentMcpCapabilityId, string>> = {
  'project.identity.read': 'Project context and search', 'project.knowledge.read': 'Wiki and materials',
  'project.work.read': 'Tasks', 'project.decisions.read': 'Decisions', 'project.results.read': 'Results',
  'project.conversations.read': 'Conversations', 'project.maps.read': 'Maps', 'project.policy.read': 'Project instructions',
  'cowork.playbook.read': 'Flux co-work instructions', 'connection.runtime.read': 'Current agent session',
  'proposal.create': 'Suggest next steps', 'work.create': 'Create tasks', 'work.update': 'Change tasks',
  'result.record': 'Record results', 'decision.propose': 'Propose decisions', 'map.create': 'Create maps',
  'map.rename': 'Rename maps', 'map.thought.create': 'Add thoughts', 'map.thought.update': 'Edit thoughts',
  'map.thought.delete': 'Remove thoughts', 'map.positions.update': 'Arrange thoughts', 'map.link.create': 'Link thoughts',
  'map.link.delete': 'Unlink thoughts', 'doc.create': 'Start wiki pages', 'doc.update': 'Edit wiki pages',
  'conversation.create': 'Start conversations', 'conversation.reply': 'Reply in conversations',
  'cowork.unit.create': 'Create work units', 'cowork.claim': 'Take work units', 'cowork.renew': 'Renew work units',
  'cowork.release': 'Release work units', 'cowork.unit.complete': 'Complete work units',
  'cowork.unit.transfer': 'Transfer work units', 'cowork.request.claim': 'Take work requests',
  'cowork.request.respond': 'Respond to work requests',
};
const READ = new Set<AgentMcpCapabilityId>(AGENT_MCP_READ_CAPABILITIES);
const CAPABILITIES = [...new Set(AGENT_MCP_ENTRIES.flatMap((entry) => entry.requiredCapabilities))];
const GROUPS = [
  { title: 'Read', ids: CAPABILITIES.filter((id) => READ.has(id)) },
  { title: 'Suggest', ids: CAPABILITIES.filter((id) => id === 'proposal.create') },
  { title: 'Act', ids: CAPABILITIES.filter((id) => !READ.has(id) && id !== 'proposal.create') },
];
const inputOf = (policy: SaveAgentMcpPolicy): SaveAgentMcpPolicy => ({ enabledCapabilityIds: [...policy.enabledCapabilityIds],
  enabledEntryIds: [...policy.enabledEntryIds], selectedProjectIds: [...policy.selectedProjectIds] });
const same = (a: SaveAgentMcpPolicy, b: SaveAgentMcpPolicy) =>
  (['enabledCapabilityIds', 'enabledEntryIds', 'selectedProjectIds'] as const)
    .every((key) => a[key].length === b[key].length && a[key].every((value) => (b[key] as readonly string[]).includes(value)));

function describe(cause: unknown) {
  if (cause instanceof NetworkError) return 'The save could not be confirmed. Reload saved permissions before trying again.';
  if (cause instanceof ApiError) {
    if (cause.status === 409) return 'Permissions changed in another tab. Reload saved permissions before editing.';
    if (cause.status === 401) return 'Your session ended. Sign in again to manage your agent.';
    if (cause.status === 403) return 'This selection is no longer allowed. Reload saved permissions and check project access.';
    if (cause.status === 404) return 'This connection is no longer available to you.';
  }
  return 'Permissions could not be saved. Reload saved permissions before trying again.';
}

/** Ordinary owner session. Draft controls change no consent, project grant or action authority. */
export function McpPermissions({ connection, projectNames }: { connection: AgentConnection; projectNames: Map<string, string> }) {
  const id = useId();
  const [settings, setSettings] = useState<McpPermissionSettings | null>(null);
  const [draft, setDraft] = useState<SaveAgentMcpPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading saved permissions…');
  const [availabilityVersion, setAvailabilityVersion] = useState<number | null>(null);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const startRequest = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController(); const ticket = ++generation.current;
    pending.current = controller;
    return { controller, current: () => ticket === generation.current && !controller.signal.aborted };
  }, []);
  const invalidate = useCallback(() => { generation.current += 1; pending.current?.abort(); }, []);
  useEffect(() => {
    const read = startRequest();
    void getMcpPermissions(connection.id, read.controller.signal).then((value) => {
      if (!read.current()) return;
      setSettings(value); setDraft(inputOf(value.policy)); setAvailabilityVersion(value.policy.version); setStatus('Showing saved permissions');
    }).catch((cause: unknown) => {
      if (!read.current()) return;
      setError(cause instanceof NetworkError ? 'Saved permissions could not be loaded. Check your connection and try again.' : 'Saved permissions could not be loaded.');
      setStatus('Permissions unavailable'); setNeedsReload(true);
    });
    return () => { invalidate(); read.controller.abort(); };
  }, [connection.id, startRequest, invalidate]);

  async function reload() {
    if (busy) return;
    const read = startRequest(); setBusy(true); setError(null);
    try {
      const value = await getMcpPermissions(connection.id, read.controller.signal);
      if (!read.current()) return;
      setSettings(value); setDraft(inputOf(value.policy)); setAvailabilityVersion(value.policy.version); setNeedsReload(false); setStatus('Showing saved permissions');
    } catch { if (read.current()) { setError('Saved permissions could not be loaded. Try again.'); setNeedsReload(true); } }
    finally { if (read.current()) setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!settings || !draft || busy || needsReload) return;
    const write = startRequest(); setBusy(true); setError(null);
    try {
      const saved = await saveMcpPermissions(connection.id, settings.policy.version, draft, write.controller.signal);
      if (!write.current()) return;
      setSettings({ ...settings, policy: saved.policy }); setDraft(inputOf(saved.policy)); setAvailabilityVersion(null); setStatus('Permissions saved');
      try {
        const current = await getMcpPermissions(connection.id, write.controller.signal);
        if (!write.current()) return;
        setSettings(current); setDraft(inputOf(current.policy)); setAvailabilityVersion(current.policy.version);
      } catch { if (write.current()) { setError('Permissions were saved, but their current availability could not be refreshed. Reload to check.'); setNeedsReload(true); } }
    } catch (cause) { if (write.current()) { setError(describe(cause)); setNeedsReload(true); setStatus('Save not confirmed'); } }
    finally { if (write.current()) setBusy(false); }
  }
  const dirty = !!settings && !!draft && !same(settings.policy, draft);
  function toggle(capability: AgentMcpCapabilityId, on: boolean) {
    if (!draft || !settings) return;
    const capabilities = new Set(draft.enabledCapabilityIds);
    if (on) capabilities.add(capability); else capabilities.delete(capability);
    // An explicit On acknowledges only the current, known server entries within
    // original consent. Merely loading a group never admits a new alias.
    const entries = new Set(draft.enabledEntryIds);
    if (on) for (const entry of AGENT_MCP_ENTRIES) {
      if (entry.requiredCapabilities.includes(capability) && connection.scopes.includes(entry.requiredScope)
        && settings.entries.some((current) => current.id === entry.id)) entries.add(entry.id);
    }
    setDraft({ ...draft, enabledCapabilityIds: [...capabilities], enabledEntryIds: [...entries] });
    setStatus('Changes are not saved yet');
  }
  return <section className="mcp-permissions" aria-label={`Permissions for ${connection.name}`} aria-busy={busy || undefined}>
    <header><h2>What this agent can use</h2><p>Choose what {connection.name} may read, suggest and change. Save to apply your switches.</p></header>
    <p className="mcp-permissions__status" role="status">{status}</p>
    {error ? <p role="alert" className="connection__alert">{error}</p> : null}
    <Button variant="link" busy={busy} onClick={() => { void reload(); }}>Reload saved permissions</Button>
    {settings && draft ? <form onSubmit={(event) => { void save(event); }}>
      <fieldset disabled={busy || needsReload}>
        <legend>Selected projects</legend>
        {settings.projects.map((project) => <label className="mcp-permissions__row" key={project.id}>
          <span><strong>{projectNames.get(project.id) ?? `Unavailable project ${project.id.slice(0, 8)}`}</strong>
            {!project.readable ? <small>Project access is unavailable. You can remove this selection.</small> : null}</span>
          <input type="checkbox" role="switch" checked={draft.selectedProjectIds.includes(project.id)}
            disabled={!project.readable && !draft.selectedProjectIds.includes(project.id)} onChange={(event) => {
              const selected = new Set(draft.selectedProjectIds); if (event.target.checked) selected.add(project.id); else selected.delete(project.id);
              setDraft({ ...draft, selectedProjectIds: [...selected] }); setStatus('Changes are not saved yet');
            }} />
        </label>)}
        {!draft.selectedProjectIds.length ? <p className="mcp-permissions__note">No project is selected.</p> : null}
      </fieldset>
      {GROUPS.map((group) => <details key={group.title} open={group.title === 'Read'}>
        <summary>{group.title}</summary>
        <fieldset disabled={busy || needsReload} aria-labelledby={`${id}-${group.title}`}>
          <legend id={`${id}-${group.title}`} className="mcp-permissions__legend">{group.title} permissions</legend>
          {group.ids.map((capability) => {
            const entries = settings.entries.filter((entry) => entry.requiredCapabilities.includes(capability));
            const supported = !!LABEL[capability] && entries.some((entry) => connection.scopes.includes(entry.requiredScope));
            const enabled = draft.enabledCapabilityIds.includes(capability);
            const partial = settings.policy.enabledCapabilityIds.includes(capability)
              && entries.some((entry) => connection.scopes.includes(entry.requiredScope) && !settings.policy.enabledEntryIds.includes(entry.id));
            const available = entries.some((entry) => entry.available);
            const availabilityKnown = availabilityVersion === settings.policy.version;
            const prerequisites = [...new Set(entries.flatMap((entry) => entry.requiredCapabilities)
              .filter((required) => required !== capability && !settings.policy.enabledCapabilityIds.includes(required)))];
            const reason = !supported ? 'Requires a new connection with your consent' : !availabilityKnown ? 'Saved access needs refreshing'
              : !settings.policy.enabledCapabilityIds.includes(capability)
              ? 'Saved: Off' : partial ? 'Saved: some tools are off' : available ? 'Saved: available'
                : group.title === 'Act' ? 'Saved: each action also needs a current grant and agent session' : 'Saved: check selected projects and related permissions';
            return <label className="mcp-permissions__row" key={capability}>
              <span><strong>{LABEL[capability] ?? 'Unavailable capability'}</strong><small>{reason}</small>
                {availabilityKnown && prerequisites.length ? <small>Related tools also need: {prerequisites.map((required) => LABEL[required] ?? 'an unavailable permission').join(', ')}.</small> : null}</span>
              <input type="checkbox" role="switch" checked={enabled} disabled={!supported && !enabled}
                onChange={(event) => toggle(capability, event.target.checked)} />
            </label>;
          })}
        </fieldset>
      </details>)}
      <p className="mcp-permissions__note">Action switches work within the grants you already gave this agent. Flux checks current access and limits on each action.</p>
      <div className="mcp-permissions__actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!dirty || needsReload}>Save permissions</Button>
        <Button disabled={!dirty || busy || needsReload} onClick={() => { setDraft(inputOf(settings.policy)); setStatus('Showing saved permissions'); }}>Discard changes</Button>
        <Button variant="link" disabled={busy || needsReload} onClick={() => {
          setDraft({ enabledCapabilityIds: [], enabledEntryIds: [], selectedProjectIds: [] }); setStatus('Changes are not saved yet');
        }}>Disable all</Button>
      </div>
    </form> : null}
  </section>;
}
