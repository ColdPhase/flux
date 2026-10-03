import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigation, useRevalidator } from 'react-router';
import type { GithubBinding, GithubCapabilities, GithubRepository, GithubTaskLink } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { useProjectShell, type ProjectShell } from '../project/data';
import { Button, Spinner } from '../ui';
import { useShellData } from '../app/data';
import { useWorkChoices } from '../work/useDetailReads';
import { WorkPagination } from '../work/WorkPagination';
import './github.css';
const failure = (cause: unknown) => cause instanceof ApiError && cause.status < 500 ? cause.message : 'GitHub is unavailable. Your work is saved; try again when the connection returns.';
export function GithubSettings() {
  const shell = useProjectShell();
  const { me } = useShellData();
  // A different project gets a fresh private projection, including its pending requests.
  return shell ? <GithubProjectSettings key={`${me.user.id}:${shell.project.id}`} shell={shell} /> : null;
}
function GithubProjectSettings({ shell }: { shell: ProjectShell }) {
  const projectId = shell.project.id; const prefix = `/api/v1/projects/${projectId}/github`;
  const [capabilities, setCapabilities] = useState<GithubCapabilities | null>(null);
  const [bindings, setBindings] = useState<GithubBinding[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const loadRequest = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    loadRequest.current?.abort(); const controller = new AbortController(); loadRequest.current = controller;
    return request<GithubCapabilities>(`${prefix}/capabilities`, { signal: controller.signal }).then(async (current) => {
      try {
        const rows = current.status === 'configured' && current.authorization === 'connected'
          ? await request<GithubBinding[]>(`${prefix}/bindings`, { signal: controller.signal }) : [];
        if (controller.signal.aborted) return;
        setBindings(rows); setCapabilities(current);
      } catch (cause) { if (!controller.signal.aborted) { setCapabilities(current); setBindings([]); setError(failure(cause)); } }
    }).catch((cause) => { if (!controller.signal.aborted) { setCapabilities(null); setBindings([]); setError(failure(cause)); } });
  }, [prefix]);
  useEffect(() => { void load(); return () => loadRequest.current?.abort(); }, [load]);
  function refresh() { setCapabilities(null); setBindings([]); setError(''); return load(); }
  async function connect(purpose: 'authorize' | 'install') {
    setBusy(true); setError('');
    try { const result = await request<{ url: string }>(`${prefix}/${purpose}`, { method: 'POST' }); const url = new URL(result.url);
      if (url.origin !== 'https://github.com') throw new Error('Invalid authorization origin'); window.location.assign(url.toString());
    } catch (cause) { setError(failure(cause)); setBusy(false); }
  }
  async function disconnect(id: string) {
    setBusy(true); setError(''); try { await request(`/api/v1/github/bindings/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }
  return <div className="pane-scroll"><div className="pane-in github-settings">
    <div className="github-settings__head"><div><h2>GitHub repositories</h2><p>Connect repositories to {shell.project.name} and keep verified pull requests beside your existing tasks.</p></div>
      <Link className="ui-link" to={`/projects/${projectId}`}>Back to project</Link></div>
    <p className="github-settings__note">Private repository details are shown only when your own GitHub account and Flux access both permit them.</p>
    {error ? <p role="alert" className="github-settings__error">{error}</p> : null}
    {!capabilities ? error ? <Button variant="secondary" onClick={() => void refresh()}>Check access again</Button> : <Spinner label="Loading GitHub settings" /> : capabilities.status === 'unavailable'
      ? <section><h3>GitHub is not configured on this server</h3><p>Your server operator can configure a GitHub App with read access. Your tasks and conversations remain available.</p><Button variant="secondary" onClick={() => void refresh()}>Check again</Button></section>
      : capabilities.authorization !== 'connected'
        ? <section><h3>{capabilities.authorization === 'uncertain' ? 'Reconnect your GitHub account' : 'Authorize your GitHub account'}</h3><p>Choose your own account on GitHub. Signing in to Flux and authorizing GitHub are separate steps.</p><Button busy={busy} onClick={() => void connect('authorize')}>Continue to GitHub</Button></section>
        : <>
          <div className="github-settings__actions"><Button variant="secondary" busy={busy} onClick={() => void refresh()}>Refresh access</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void connect('authorize')}>Reconnect GitHub account</Button>
            {shell.project.access === 'manager' ? <Button variant="secondary" disabled={busy} onClick={() => void connect('install')}>Install App on repositories</Button> : null}
            <Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await request('/api/v1/github/authorization', { method: 'DELETE' }); await refresh(); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }}>Disconnect your GitHub account</Button></div>
          <section><h3>Connected repositories</h3>{bindings.length ? <ul className="github-settings__repos">{bindings.map((binding) => <li key={binding.id}>
            <a href={binding.url} target="_blank" rel="noreferrer">{binding.owner}/{binding.name}</a><span>{binding.private ? 'Private' : 'Public'}</span>
            {shell.project.access === 'manager' ? <Button variant="secondary" disabled={busy} onClick={() => void disconnect(binding.id)}>Disconnect</Button> : null}</li>)}</ul> : <p>{error ? 'Repository access could not be verified. Refresh access or reconnect your account.' : 'No repositories connected to this project yet.'}</p>}</section>
          {shell.project.access === 'manager' ? <RepositoryPicker prefix={prefix} onBound={refresh} /> : null}
          {bindings.length ? <PullReferences projectId={projectId} bindings={bindings} canLink={shell.project.access !== 'viewer'} /> : null}
        </>}
    <p className="github-settings__note">Task automation and agent event delivery are not available yet. Merge, checks and reviews stay visible on GitHub; they do not complete your task’s acceptance criteria.</p>
  </div></div>;
}
function RepositoryPicker({ prefix, onBound }: { prefix: string; onBound: () => Promise<void> }) {
  const id = useId(); const [installations, setInstallations] = useState<{ id: string; account: string }[]>([]); const [installation, setInstallation] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]); const [repository, setRepository] = useState(''); const [page, setPage] = useState(1); const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function listInstallations() { setBusy(true); setError(''); try { setInstallations(await request(`${prefix}/installations`)); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  async function listRepos(value: string, nextPage = 1) {
    setInstallation(value); setRepository(''); setRepositories([]); setMore(false); setPage(1); setError('');
    if (!value) return;
    setBusy(true);
    try { const window = await request<{ items: GithubRepository[]; more: boolean }>(`${prefix}/installations/${value}/repositories?page=${nextPage}`); setRepositories(window.items); setMore(window.more); setPage(nextPage); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }
  async function bind(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await request(`${prefix}/bindings`, { method: 'POST', body: { installationId: installation, repositoryId: repository } }); await onBound(); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  return <section><h3>Add a repository</h3><p>Select an installed App and a repository you can currently access. New repositories are added here only when you choose them.</p>
    <Button variant="secondary" busy={busy} onClick={() => void listInstallations()}>Choose installation</Button>
    {installations.length ? <form onSubmit={(event) => void bind(event)} className="github-settings__form">
      <label htmlFor={`${id}-installation`}>Installation</label><select id={`${id}-installation`} value={installation} disabled={busy} onChange={(event) => void listRepos(event.target.value)}><option value="">Choose account…</option>{installations.map((row) => <option key={row.id} value={row.id}>{row.account} · installation {row.id}</option>)}</select>
      <label htmlFor={`${id}-repository`}>Repository</label><select id={`${id}-repository`} value={repository} disabled={busy || !installation} onChange={(event) => setRepository(event.target.value)}><option value="">Choose repository…</option>{repositories.map((row) => <option key={row.repositoryId} value={row.repositoryId}>{row.owner}/{row.name}{row.private ? ' · private' : ''}</option>)}</select>
      <div className="github-settings__actions">{page > 1 ? <Button variant="secondary" disabled={busy} onClick={() => void listRepos(installation, page - 1)}>Previous repositories</Button> : null}{more ? <Button variant="secondary" disabled={busy} onClick={() => void listRepos(installation, page + 1)}>More repositories</Button> : null}<Button type="submit" busy={busy} disabled={!repository}>Connect repository</Button></div>
    </form> : null}{error ? <p role="alert" className="github-settings__error">{error}</p> : null}
  </section>;
}
function PullReferences({ projectId, bindings, canLink }: { projectId: string; bindings: GithubBinding[]; canLink: boolean }) {
  const { me } = useShellData();
  const [search, setSearch] = useState('');
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const identityReady = navigation.state === 'idle' && revalidator.state === 'idle';
  const choices = useWorkChoices(me.user.id, projectId, identityReady ? { purpose: 'choices', choice: 'doc_refs', kind: 'work', q: search.trim() || undefined } : null);
  const canCommit = identityReady && choices.read.phase === 'ready' && choices.page?.summary.access !== 'viewer';
  const tasks = choices.page?.items ?? [];
  // One explicitly chosen identity is private form state, never a growing page cache.
  const [chosen, setChosen] = useState<{ id: string; title: string } | null>(null);
  const id = useId(); const [task, setTask] = useState(''); const [binding, setBinding] = useState(''); const [number, setNumber] = useState('');
  const [role, setRole] = useState<'required_output' | 'related'>('required_output'); const [links, setLinks] = useState<GithubTaskLink[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function openTask(value: string) { setTask(value); setChosen(tasks.find((row) => row.id === value) ?? (chosen?.id === value ? chosen : null)); setLinks([]); setError(''); if (!value) return; setBusy(true);
    try { setLinks(await request(`/api/v1/work/${value}/github-links`)); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  async function link(event: FormEvent) { event.preventDefault(); setError(''); setBusy(true); try {
    await request(`/api/v1/work/${task}/github-links`, { method: 'POST', body: { bindingId: binding, number: Number(number), role } }); setLinks(await request(`/api/v1/work/${task}/github-links`));
  } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  const taskPicker = <><label htmlFor={`${id}-search`}>Find task</label><input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
    <label htmlFor={`${id}-task`}>Task</label><select id={`${id}-task`} value={task} disabled={busy || choices.busy || !choices.page} onChange={(event) => void openTask(event.target.value)}><option value="">Choose task…</option>{chosen && !tasks.some((row) => row.id === chosen.id) ? <option value={chosen.id}>{chosen.title}</option> : null}{tasks.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select>
    <WorkPagination {...choices} label="GitHub task choices" noun="tasks" />
    {choices.read.phase === 'unavailable' ? <p role="alert">Tasks could not be loaded. Your selection is kept. <button type="button" className="ui-link" onClick={choices.onRefresh}>Refresh task choices</button></p> : null}</>;
  return <section><h3>{canLink ? 'Link an existing pull request' : 'Linked pull requests'}</h3><p>{canLink ? 'Select the task, repository and exact PR number. Flux verifies the original PR; your existing tasks remain authoritative.' : 'Choose an existing task to read its verified pull requests under your own current repository access.'}</p>
    {canLink ?
    <form onSubmit={(event) => void link(event)} className="github-settings__form">
      {taskPicker}
      <label htmlFor={`${id}-binding`}>Repository</label><select id={`${id}-binding`} value={binding} disabled={busy} onChange={(event) => setBinding(event.target.value)}><option value="">Choose repository…</option>{bindings.map((row) => <option key={row.id} value={row.id}>{row.owner}/{row.name}</option>)}</select>
      <label htmlFor={`${id}-number`}>Pull request number</label><input id={`${id}-number`} type="number" min="1" required disabled={busy} value={number} onChange={(event) => setNumber(event.target.value)} />
      <label htmlFor={`${id}-role`}>Relationship</label><select id={`${id}-role`} value={role} disabled={busy} onChange={(event) => setRole(event.target.value as typeof role)}><option value="required_output">Required output</option><option value="related">Related context</option></select>
      <Button type="submit" busy={busy} disabled={!task || !binding || !number || !canCommit}>Verify and link PR</Button>
    </form> : <div className="github-settings__form">{taskPicker}</div>}{error ? <p role="alert" className="github-settings__error">{error}</p> : null}
    {links.length ? <ul className="github-settings__pulls">{links.map((row) => <li key={row.id}><a href={row.facts.url} target="_blank" rel="noreferrer">#{row.facts.number} · {row.facts.title}</a>
      <span>{row.role === 'required_output' ? 'Required output' : 'Related'} · {row.facts.execution.replaceAll('_', ' ')} · {row.state}</span>
      <span>GitHub author {row.facts.author.login} · head {row.facts.headSha.slice(0, 12)} · checked {new Date(row.verifiedAt).toLocaleString()}</span></li>)}</ul> : null}
  </section>;
}
