import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigation, useRevalidator } from 'react-router';
import type { GithubBinding, GithubCapabilities, GithubRepository, GithubRuleDefault, GithubTaskLink } from '@flux/contracts';
import { ApiError } from '../api/client';
import { bindGithubRepository, disconnectGithubAccount, disconnectGithubBinding, getGithubCapabilities, linkTaskPull, listGithubBindings, listGithubInstallations, listGithubRepositories, listTaskGithubLinks, saveGithubRuleDefault, startGithub } from './api';
import { useProjectShell, type ProjectShell } from '../project/data';
import { Button, Spinner, Select, Option } from '../ui';
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
  const projectId = shell.project.id;
  const [capabilities, setCapabilities] = useState<GithubCapabilities | null>(null);
  // The default as last saved here; the link form discloses it (#74 G-1a).
  const [savedDefault, setSavedDefault] = useState<{ value: GithubRuleDefault | null } | null>(null);
  const ruleDefault = savedDefault ? savedDefault.value : capabilities?.ruleDefault ?? null;
  const [bindings, setBindings] = useState<GithubBinding[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const loadRequest = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    loadRequest.current?.abort(); const controller = new AbortController(); loadRequest.current = controller;
    return getGithubCapabilities(projectId, controller.signal).then(async (current) => {
      try {
        const rows = current.status === 'configured' && current.authorization === 'connected'
          ? await listGithubBindings(projectId, controller.signal) : [];
        if (controller.signal.aborted) return;
        setBindings(rows); setCapabilities(current);
      } catch (cause) { if (!controller.signal.aborted) { setCapabilities(current); setBindings([]); setError(failure(cause)); } }
    }).catch((cause) => { if (!controller.signal.aborted) { setCapabilities(null); setBindings([]); setError(failure(cause)); } });
  }, [projectId]);
  useEffect(() => { void load(); return () => loadRequest.current?.abort(); }, [load]);
  function refresh() { setCapabilities(null); setBindings([]); setError(''); return load(); }
  async function connect(purpose: 'authorize' | 'install') {
    setBusy(true); setError('');
    try { const result = await startGithub(projectId, purpose); const url = new URL(result.url);
      if (url.origin !== 'https://github.com') throw new Error('Invalid authorization origin'); window.location.assign(url.toString());
    } catch (cause) { setError(failure(cause)); setBusy(false); }
  }
  async function disconnect(id: string) {
    setBusy(true); setError(''); try { await disconnectGithubBinding(id); await refresh(); }
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
            <Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await disconnectGithubAccount(); await refresh(); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }}>Disconnect your GitHub account</Button></div>
          <section><h3>Connected repositories</h3>{bindings.length ? <ul className="github-settings__repos">{bindings.map((binding) => <li key={binding.id}>
            <a href={binding.url} target="_blank" rel="noreferrer">{binding.owner}/{binding.name}</a><span>{binding.private ? 'Private' : 'Public'}</span>
            {shell.project.access === 'manager' ? <Button variant="secondary" disabled={busy} onClick={() => void disconnect(binding.id)}>Disconnect</Button> : null}</li>)}</ul> : <p>{error ? 'Repository access could not be verified. Refresh access or reconnect your account.' : 'No repositories connected to this project yet.'}</p>}</section>
          {shell.project.access === 'manager' ? <RepositoryPicker projectId={projectId} onBound={refresh} /> : null}
          {shell.project.access === 'manager' && bindings.length ? <RuleDefault projectId={projectId} current={ruleDefault} onSaved={(value) => setSavedDefault({ value })} /> : null}
          {bindings.length ? <PullReferences projectId={projectId} bindings={bindings} canLink={shell.project.access !== 'viewer'} ruleDefault={ruleDefault} /> : null}
        </>}
    <p className="github-settings__note">Linked PRs move a task only when someone who can edit it turns that on in the task’s Details, or links a required PR while this project’s default below is on. A merge never checks off written criteria. Agent event delivery is not available yet.</p>
  </div></div>;
}
/** A manager's default (#74 G-1a): whoever links a required PR to a task without a rule turns its rule on. */
function RuleDefault({ projectId, current, onSaved }: { projectId: string; current: GithubRuleDefault | null; onSaved: (value: GithubRuleDefault | null) => void }) {
  const id = useId(); const value = current; const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(enabled: boolean, mode: GithubRuleDefault['mode']) {
    setBusy(true); setError('');
    try { onSaved((await saveGithubRuleDefault(projectId, enabled, mode)).ruleDefault); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }
  return <section><h3>New required pull requests</h3>
    <p>When someone links a required PR to a task that has no rule yet, Flux turns on “Let linked PRs move this task” for it, on that person’s behalf. Everyone who can see the task then sees its status changes, with PR numbers, check names and commits.</p>
    <label className="github-settings__check"><input type="checkbox" checked={!!value} disabled={busy} onChange={(event) => void save(event.target.checked, value?.mode ?? null)} /> Turn it on for new required links</label>
    {value ? <div className="github-settings__form"><label htmlFor={`${id}-mode`}>When every PR is merged</label>
      <Select id={`${id}-mode`} value={value.mode ?? ''} disabled={busy} onChange={(next) => void save(true, (next || null) as GithubRuleDefault['mode'])}>
        <Option value="">Ready to close if the task has written criteria, otherwise done</Option><Option value="ready">Always Ready to close</Option><Option value="complete">Done unless the task has written criteria</Option>
      </Select></div> : null}
    {error ? <p role="alert" className="github-settings__error">{error}</p> : null}
  </section>;
}
function RepositoryPicker({ projectId, onBound }: { projectId: string; onBound: () => Promise<void> }) {
  const id = useId(); const [installations, setInstallations] = useState<{ id: string; account: string }[]>([]); const [installation, setInstallation] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]); const [repository, setRepository] = useState(''); const [page, setPage] = useState(1); const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function listInstallations() { setBusy(true); setError(''); try { setInstallations(await listGithubInstallations(projectId)); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  async function listRepos(value: string, nextPage = 1) {
    setInstallation(value); setRepository(''); setRepositories([]); setMore(false); setPage(1); setError('');
    if (!value) return;
    setBusy(true);
    try { const window = await listGithubRepositories(projectId, value, nextPage); setRepositories(window.items); setMore(window.more); setPage(nextPage); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  }
  async function bind(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await bindGithubRepository(projectId, installation, repository); await onBound(); }
    catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  return <section><h3>Add a repository</h3><p>Select an installed App and a repository you can currently access. New repositories are added here only when you choose them.</p>
    <Button variant="secondary" busy={busy} onClick={() => void listInstallations()}>Choose installation</Button>
    {installations.length ? <form onSubmit={(event) => void bind(event)} className="github-settings__form">
      <label htmlFor={`${id}-installation`}>Installation</label><Select id={`${id}-installation`} value={installation} disabled={busy} onChange={(next) => void listRepos(next)}><Option value="">Choose account…</Option>{installations.map((row) => <Option key={row.id} value={row.id}>{row.account} · installation {row.id}</Option>)}</Select>
      <label htmlFor={`${id}-repository`}>Repository</label><Select id={`${id}-repository`} value={repository} disabled={busy || !installation} onChange={(next) => setRepository(next)}><Option value="">Choose repository…</Option>{repositories.map((row) => <Option key={row.repositoryId} value={row.repositoryId}>{row.owner}/{row.name}{row.private ? ' · private' : ''}</Option>)}</Select>
      <div className="github-settings__actions">{page > 1 ? <Button variant="secondary" disabled={busy} onClick={() => void listRepos(installation, page - 1)}>Previous repositories</Button> : null}{more ? <Button variant="secondary" disabled={busy} onClick={() => void listRepos(installation, page + 1)}>More repositories</Button> : null}<Button type="submit" busy={busy} disabled={!repository}>Connect repository</Button></div>
    </form> : null}{error ? <p role="alert" className="github-settings__error">{error}</p> : null}
  </section>;
}
function PullReferences({ projectId, bindings, canLink, ruleDefault }: { projectId: string; bindings: GithubBinding[]; canLink: boolean; ruleDefault: GithubRuleDefault | null }) {
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
    try { setLinks(await listTaskGithubLinks(value)); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  async function link(event: FormEvent) { event.preventDefault(); setError(''); setBusy(true); try {
    await linkTaskPull(task, { bindingId: binding, number: Number(number), role }); setLinks(await listTaskGithubLinks(task));
  } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } }
  const taskPicker = <><label htmlFor={`${id}-search`}>Find task</label><input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
    <label htmlFor={`${id}-task`}>Task</label><Select id={`${id}-task`} value={task} disabled={busy || choices.busy || !choices.page} onChange={(next) => void openTask(next)}><Option value="">Choose task…</Option>{chosen && !tasks.some((row) => row.id === chosen.id) ? <Option value={chosen.id}>{chosen.title}</Option> : null}{tasks.map((row) => <Option key={row.id} value={row.id}>{row.title}</Option>)}</Select>
    <WorkPagination {...choices} label="GitHub task choices" noun="tasks" />
    {choices.read.phase === 'unavailable' ? <p role="alert">Tasks could not be loaded. Your selection is kept. <button type="button" className="ui-link" onClick={choices.onRefresh}>Refresh task choices</button></p> : null}</>;
  return <section><h3>{canLink ? 'Link an existing pull request' : 'Linked pull requests'}</h3><p>{canLink ? 'Select the task, repository and exact PR number. Flux verifies the original PR; your existing tasks remain authoritative.' : 'Choose an existing task to read its verified pull requests under your own current repository access.'}</p>
    {canLink ?
    <form onSubmit={(event) => void link(event)} className="github-settings__form">
      {taskPicker}
      <label htmlFor={`${id}-binding`}>Repository</label><Select id={`${id}-binding`} value={binding} disabled={busy} onChange={(next) => setBinding(next)}><Option value="">Choose repository…</Option>{bindings.map((row) => <Option key={row.id} value={row.id}>{row.owner}/{row.name}</Option>)}</Select>
      <label htmlFor={`${id}-number`}>Pull request number</label><input id={`${id}-number`} type="number" min="1" required disabled={busy} value={number} onChange={(event) => setNumber(event.target.value)} />
      <label htmlFor={`${id}-role`}>Relationship</label><Select id={`${id}-role`} value={role} disabled={busy} onChange={(next) => setRole(next as typeof role)}><Option value="required_output">Required output</Option><Option value="related">Related context</Option></Select>
      {ruleDefault && role === 'required_output' ? <p className="github-settings__disclose" role="note">This project’s default turns on “Let linked PRs move this task” for a task without a rule, on your behalf. Everyone who can see the task then sees its status changes, with PR numbers, check names and commits.</p> : null}
      <Button type="submit" busy={busy} disabled={!task || !binding || !number || !canCommit}>Verify and link PR</Button>
    </form> : <div className="github-settings__form">{taskPicker}</div>}{error ? <p role="alert" className="github-settings__error">{error}</p> : null}
    {links.length ? <ul className="github-settings__pulls">{links.map((row) => <li key={row.id}><a href={row.facts.url} target="_blank" rel="noreferrer">#{row.facts.number} · {row.facts.title}</a>
      <span>{row.role === 'required_output' ? 'Required output' : 'Related'} · {row.facts.execution.replaceAll('_', ' ')} · {row.state}</span>
      <span>GitHub author {row.facts.author.login} · head {row.facts.headSha.slice(0, 12)} · checked {new Date(row.verifiedAt).toLocaleString()}</span></li>)}</ul>
      : task && !busy && !error ? <p className="github-settings__none">No pull requests are linked to this task yet.</p> : null}
  </section>;
}
