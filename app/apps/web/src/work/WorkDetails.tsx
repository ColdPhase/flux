import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useRevalidator } from 'react-router';
import type { Agent, Decision, ObjectLink, Project, WorkItem, WorkResult, WorkspaceMember, WorkStatus } from '@flux/contracts';
import { WORK_STATUSES } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Input } from '../ui';
import { getProject, listWorkspaceMembers } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { useShellActions, type ObjectView, type WorkFormView } from '../app/shellContext';
import { acceptDecision, createResult, getDecision, getResult, getWork, listAgents, loadProjectWork, proposeDecision, updateWork, type ProjectWork } from './api';
import { STATUS_LABEL, decisionLine, firstLine, isFinished, linked, resultLine, shortDate } from './format';
import { docsLinking } from '../docs/AddToDoc';
import { TaskDiscussionSection } from './TaskDiscussion';

// The Details panel for work items, decisions and results, and the two forms that start from a
// message (#101). Everything shown here is visible to the people with access to the project;
// the panel says so. Changes send If-Match and an Idempotency-Key that retries reuse.

interface Context {
  project: Project;
  lists: ProjectWork;
  members: WorkspaceMember[];
  agents: Agent[];
}

const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403 ? [] : Promise.reject(error);

async function loadContext(projectId: string, signal: AbortSignal): Promise<Context> {
  const project = await getProject(projectId, signal);
  const [lists, members, agents] = await Promise.all([
    loadProjectWork(projectId, signal),
    listWorkspaceMembers(project.workspaceId, signal).catch(forbidden),
    listAgents(project.workspaceId, signal).catch(forbidden),
  ]);
  return { project, lists, members, agents: agents.filter((agent) => !agent.revokedAt) };
}

function readable(error: unknown) {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return 'Someone changed this a moment ago. The latest version is shown; try again if it still applies.';
  if (error instanceof ApiError && error.code === 'TASK_PREREQUISITES_UNMET') return 'It can start or finish only when every task it waits for is done and not parked.';
  if (error instanceof ApiError && error.code === 'WORK_NOT_FINISHABLE') return 'That work was parked or set aside meanwhile, so this result cannot finish it. The latest state is shown.';
  if (error instanceof ApiError && error.code === 'SUPERSEDED_DECISION_CHANGED') return 'The rule this would replace has already changed. Review the current rule first.';
  if (error instanceof ApiError && error.status === 404) return 'This is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project but not change it.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}

/** Object and form views of the Details panel. */
export function WorkDetails({ view }: { view: ObjectView | WorkFormView }) {
  const [loaded, setState] = useState<{ key: string; object: WorkItem | Decision | WorkResult | null; context: Context } | null>(null);
  const [failed, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const revalidator = useRevalidator();
  const reload = useCallback(() => { setTick((value) => value + 1); revalidator.revalidate(); }, [revalidator]);
  const viewKey = 'id' in view ? `${view.kind}:${view.id}` : `${view.kind}:${view.projectId}:${view.source?.messageId ?? ''}:${view.workId ?? ''}`;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const object = 'id' in view
        ? await (view.kind === 'work' ? getWork(view.id, controller.signal) : view.kind === 'decision' ? getDecision(view.id, controller.signal) : getResult(view.id, controller.signal))
        : null;
      const context = await loadContext(object?.projectId ?? (view as WorkFormView).projectId, controller.signal);
      setState({ key: viewKey, object, context }); setFailure(null);
    })().catch((error: unknown) => { if (!controller.signal.aborted) { setState(null); setFailure({ key: viewKey, text: readable(error) }); } });
    return () => controller.abort();
    // viewKey identifies the view; tick reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, tick]);

  // While another view loads, the previous one's data must not be read as this view's.
  const state = loaded?.key === viewKey ? loaded : null;
  const failure = failed?.key === viewKey ? failed.text : '';
  if (failure && !state) return <div className="details"><p className="details__eyebrow">Details</p><h3 className="details__title">Not available</h3><p className="details__lead" role="alert">{failure}</p></div>;
  if (!state) return <div className="details" aria-busy="true"><p className="details__lead">Loading…</p></div>;
  const { object, context } = state;
  if (view.kind === 'propose-decision') return <ProposeDecision key={viewKey} view={view} context={context} />;
  if (view.kind === 'attach-result') return <AttachResult key={viewKey} view={view} context={context} reload={reload} />;
  if (view.kind === 'work') return <WorkPanel key={`${viewKey}:${(object as WorkItem).version}`} item={object as WorkItem} context={context} reload={reload} />;
  if (view.kind === 'decision') return <DecisionPanel key={`${viewKey}:${(object as Decision).version}`} decision={object as Decision} context={context} reload={reload} />;
  return <ResultPanel result={object as WorkResult} context={context} />;
}

function Audience({ project }: { project: Project }) {
  return (
    <section className="details__sec" aria-labelledby="wd-audience">
      <h4 id="wd-audience">Who can see this</h4>
      <p className="wd-audience"><Icon name="lock" size={13} />Everyone with access to {project.name}</p>
    </section>
  );
}

/** Buttons and links to the other ends of an object's links. */
function Linked({ items, empty }: { items: { key: string; label: ReactNode; open: () => void; hint?: string }[]; empty?: string }) {
  if (!items.length) return empty ? <p className="wd-muted">{empty}</p> : null;
  return <ul className="wd-links">{items.map((item) => <li key={item.key}><button type="button" className="wd-link" onClick={item.open}><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}<Icon name="chevron-right" size={14} /></button></li>)}</ul>;
}

function Sources({ links, id, project }: { links: ObjectLink[]; id: string; project: Project }) {
  const sources = links.filter((link) => link.from.id === id && link.role === 'source');
  if (!sources.length) return null;
  return (
    <ul className="wd-links">
      {sources.map((link) => {
        const to = link.to.type === 'message'
          ? `/projects/${project.id}/conversations/${link.conversationId}#message-${link.to.id}`
          : link.to.type === 'material' ? `/materials/${link.to.id}/versions/${link.to.version}`
            : link.to.type === 'thought' && link.sketchId ? `/projects/${project.id}/map/${link.sketchId}` : null;
        const kind = link.to.type === 'message' ? 'Message' : link.to.type === 'thought' ? 'Thought' : `Material v${link.to.type === 'material' ? link.to.version : ''}`;
        return <li key={link.id}>{to ? <Link className="wd-link" to={to}><span><b>{kind}:</b> {link.toTitle}</span><Icon name="chevron-right" size={14} /></Link> : null}</li>;
      })}
    </ul>
  );
}

/** Docs that include or mention this result or decision (#112), and "Add to docs". */
function InDocs({ object, kind, project }: { object: { id: string; title: string; links: ObjectLink[] }; kind?: 'result' | 'decision'; project: Project }) {
  const { openDetails } = useShellActions();
  const docs = docsLinking(object.links, object.id);
  const writable = project.access !== 'viewer';
  return (
    <section className="details__sec" aria-labelledby={`wd-docs-${object.id}`}>
      <h4 id={`wd-docs-${object.id}`}>In docs</h4>
      {docs.length ? (
        <ul className="wd-links">{docs.map((doc) => <li key={doc.id}><Link className="wd-link" to={`/projects/${project.id}/docs/${doc.id}`}><span>{doc.title}</span>{doc.role === 'source' ? <small>added</small> : <small>mentioned</small>}<Icon name="chevron-right" size={14} /></Link></li>)}</ul>
      ) : <p className="wd-muted">Not in a doc yet.</p>}
      {writable && kind ? <div className="wd-actions"><Button variant="secondary" icon="doc" onClick={() => openDetails({ kind: 'add-to-doc', projectId: project.id, from: { type: kind, id: object.id, title: object.title }, inDocs: docs.filter((doc) => doc.role === 'source').map((doc) => doc.id) })}>Add to docs</Button></div> : null}
    </section>
  );
}

function IdsLine({ children }: { children: ReactNode }) {
  return <p className="wd-ids">{children}</p>;
}

function WorkPanel({ item, context, reload }: { item: WorkItem; context: Context; reload: () => void }) {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  const writable = context.project.access !== 'viewer';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocker, setBlocker] = useState(item.blocker ?? '');
  const statusId = useId();
  const ownerId = useId();
  const decisions = linked(item.links, item.id, 'decision');
  const results = linked(item.links, item.id, 'result');
  const parkedBy = item.parked ? context.lists.decisions.find((decision) => decision.id === item.parked!.decisionId) : null;
  // An open task is the most specific place to work together, and a fragment others can open.
  const liveAnchor = { projectId: item.projectId, context: { type: 'work' as const, id: item.id }, label: item.title };
  useRegisterLiveHere(liveAnchor, { ref: { type: 'work', id: item.id, version: item.version }, label: item.title, what: 'task' });

  // The same change of the same version retried after a lost response reuses its command UUID: it never
  // contributes the saved blocker to the task conversation twice. A different change gets a new one.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  async function change(command: Parameters<typeof updateWork>[1]) {
    const key = JSON.stringify([item.id, item.version, command]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { await updateWork(item, command, attempt.current.id); attempt.current = null; reload(); }
    catch (cause) { setError(readable(cause)); if (cause instanceof ApiError && cause.status === 409) { attempt.current = null; reload(); } }
    finally { setBusy(false); }
  }
  const ownerValue = item.owner ? `${item.owner.kind}:${item.owner.id}` : '';
  const people = context.members.length ? context.members.map((member) => ({ value: `human:${member.userId}`, label: member.userId === me.user.id ? `${member.name} (you)` : member.name }))
    : [{ value: `human:${me.user.id}`, label: `${me.user.name} (you)` }];
  if (item.owner && !people.some((person) => person.value === ownerValue) && item.owner.kind === 'human') people.push({ value: ownerValue, label: item.owner.name });
  const agents = context.agents.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` }));
  if (item.owner?.kind === 'agent' && !agents.some((agent) => agent.value === ownerValue)) agents.push({ value: ownerValue, label: `${item.owner.name} (agent)` });

  return (
    <div className="details wd">
      <p className="details__eyebrow wd-eyebrow"><span className={`wd-dot wd-dot--${item.status}`} aria-hidden="true" />{STATUS_LABEL[item.status]}{item.parked ? ' · parked, not done' : ''}</p>
      <h3 className="details__title">{item.title}</h3>
      {item.outcome ? <p className="details__lead">{item.outcome}</p> : null}
      {item.status === 'blocked' && item.blocker ? <p className="wd-blocker"><Icon name="alert" size={14} />Blocked: {item.blocker}</p> : null}
      {!isFinished(item) ? <LiveEntry variant="inline" anchor={liveAnchor} /> : null}

      {writable ? (
        <fieldset className="wd-controls" disabled={busy}>
          <legend className="ui-vh">Change this work</legend>
          <label htmlFor={statusId}>Status</label>
          <select id={statusId} value={item.status} onChange={(event) => void change({ status: event.target.value as WorkStatus })}>
            {WORK_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
          </select>
          <label htmlFor={ownerId}>Owner</label>
          <select id={ownerId} value={ownerValue} onChange={(event) => {
            const [kind, ...rest] = event.target.value.split(':');
            void change({ owner: event.target.value ? { kind: kind as 'human' | 'agent', id: rest.join(':') } : null });
          }}>
            <option value="">Nobody yet</option>
            <optgroup label="People">{people.map((person) => <option key={person.value} value={person.value}>{person.label}</option>)}</optgroup>
            {agents.length ? <optgroup label="Agents">{agents.map((agent) => <option key={agent.value} value={agent.value}>{agent.label}</option>)}</optgroup> : null}
          </select>
          {item.status === 'blocked' ? (
            <form className="wd-blocker-form" onSubmit={(event) => { event.preventDefault(); void change({ blocker: blocker.trim() || null }); }}>
              <Input label="What is it waiting for?" value={blocker} onChange={(event) => setBlocker(event.target.value)} maxLength={2000} />
              <Button type="submit" variant="secondary" busy={busy}>Save</Button>
            </form>
          ) : null}
        </fieldset>
      ) : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}

      {item.parked ? (
        <section className="details__sec" aria-labelledby="wd-parked">
          <h4 id="wd-parked">Parked by a pivot</h4>
          <p>Set aside on {shortDate(item.parked.at)} when {parkedBy ? <button type="button" className="wd-inline" onClick={() => openDetails({ kind: 'decision', id: parkedBy.id })}>“{parkedBy.title}”</button> : 'a new decision'} was accepted. It keeps its status and can come back.</p>
          {writable ? <div className="wd-actions"><Button variant="secondary" busy={busy} onClick={() => void change({ parked: false })}>Bring back into the plan</Button></div> : null}
        </section>
      ) : null}

      {item.criteria.length ? (
        <section className="details__sec" aria-labelledby={`wd-criteria-${item.id}`}>
          <h4 id={`wd-criteria-${item.id}`}>Done when</h4>
          <ul className="wd-criteria">{item.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          <p className="wd-muted">Written down by whoever planned it. Flux does not check them off.</p>
        </section>
      ) : null}

      {item.prerequisites.length ? <Prerequisites item={item} openDetails={openDetails} /> : null}

      <section className="details__sec" aria-labelledby="wd-from">
        <h4 id="wd-from">Came from</h4>
        <Sources links={item.links} id={item.id} project={context.project} />
        {!item.links.some((link) => link.from.id === item.id && link.role === 'source') && !item.planIntent ? <p className="wd-muted">Added directly on the Tasks tab.</p> : null}
        {item.planIntent ? (
          <p className="wd-plan">Planned from <Link className="wd-inline" to={`/materials/${item.planIntent.materialId}/versions/${item.planIntent.version}`}>plan revision {item.planIntent.version}</Link>
            {' '}as <code>{item.planIntent.intentKey}</code>. This task stays tied to that revision.</p>
        ) : null}
      </section>

      <TaskDiscussionSection key={`${me.user.id}:${context.project.id}:${item.id}`} workId={item.id} project={context.project} members={context.members} me={{ id: me.user.id, name: me.user.name }} />

      <section className="details__sec" aria-labelledby="wd-decisions">
        <h4 id="wd-decisions">Decisions</h4>
        <Linked empty="No decision refers to this work yet." items={decisions.map((entry) => ({ key: entry.link.id, label: entry.title, hint: entry.link.role === 'still_applies' ? 'still applies' : undefined, open: () => openDetails({ kind: 'decision', id: entry.id }) }))} />
      </section>

      <section className="details__sec" aria-labelledby="wd-results">
        <h4 id="wd-results">Results</h4>
        <Linked empty={isFinished(item) ? 'Finished without a written result.' : 'No result yet. Small tasks do not need one.'} items={results.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'result', id: entry.id }) }))} />
        {writable ? <div className="wd-actions"><Button variant="secondary" icon="plus" onClick={() => openDetails({ kind: 'attach-result', projectId: item.projectId, workId: item.id })}>Attach a result</Button></div> : null}
      </section>

      <InDocs object={item} project={context.project} />
      <Audience project={context.project} />
      <IdsLine>Added by {item.createdBy.name} · {shortDate(item.createdAt)} · version {item.version}</IdsLine>
    </div>
  );
}

/** What this task waits for: each direct prerequisite with its state in words, never colour alone. */
function Prerequisites({ item, openDetails }: { item: WorkItem; openDetails: ReturnType<typeof useShellActions>['openDetails'] }) {
  const waiting = item.prerequisites.filter((prerequisite) => !prerequisite.met).length;
  // What still blocks it comes first.
  const ordered = [...item.prerequisites].sort((a, b) => Number(a.met) - Number(b.met) || a.title.localeCompare(b.title));
  return (
    <section className="details__sec" aria-labelledby={`wd-waits-${item.id}`}>
      <h4 id={`wd-waits-${item.id}`}>Waits for</h4>
      <p className={waiting ? 'wd-waiting' : 'wd-muted'} role="status">
        {waiting ? `Waiting on ${waiting} of ${item.prerequisites.length} ${item.prerequisites.length === 1 ? 'prerequisite' : 'prerequisites'}. It can start when every one is done.` : 'Every prerequisite is done.'}
      </p>
      <ul className="wd-links">
        {ordered.map((prerequisite) => (
          <li key={prerequisite.id}>
            <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'work', id: prerequisite.id })}>
              <span className={`wd-dot wd-dot--${prerequisite.status}`} aria-hidden="true" />
              <span>{prerequisite.title}</span>
              <small>{STATUS_LABEL[prerequisite.status]}{prerequisite.parked ? ' · parked' : ''}{prerequisite.met ? '' : ' · waiting'}</small>
              <Icon name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Choice = 'keep' | 'park' | 'leave';

function DecisionPanel({ decision, context, reload }: { decision: Decision; context: Context; reload: () => void }) {
  const { openDetails } = useShellActions();
  const writable = context.project.access !== 'viewer';
  const earlier = decision.supersedes ? context.lists.decisions.find((item) => item.id === decision.supersedes) : null;
  const later = decision.supersededBy ? context.lists.decisions.find((item) => item.id === decision.supersededBy) : null;
  const affected = linked(decision.links, decision.id, 'work', ['affects']);
  const stillApplies = linked(decision.links, decision.id, 'work', ['still_applies']);
  const parked = context.lists.work.filter((item) => item.parked?.decisionId === decision.id);
  const candidates = context.lists.work.filter((item) => !isFinished(item) && !item.parked);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const pivot = decision.status === 'proposed' && !!decision.supersedes;

  async function accept(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    const pick = (choice: Choice) => Object.entries(choices).filter(([, value]) => value === choice).map(([id]) => id);
    try {
      await acceptDecision(decision, pivot ? { stillApplies: pick('keep'), park: pick('park') } : {}, attempt);
      reload();
    } catch (cause) {
      setError(readable(cause));
      if (cause instanceof ApiError && cause.status === 409) { setAttempt(crypto.randomUUID()); reload(); }
    } finally { setBusy(false); }
  }

  return (
    <div className="details wd">
      <p className={`details__eyebrow wd-eyebrow${decision.status === 'proposed' ? ' wd-need' : ''}`}><Icon name="rule" size={13} />{decisionLine(decision)}</p>
      <h3 className={`details__title${decision.status === 'superseded' ? ' wd-was' : ''}`}>{decision.title}</h3>
      {decision.rationale ? <p className="details__lead">{decision.rationale}</p> : null}
      <dl className="details__dl wd-dl">
        <dt>Proposed</dt><dd>{decision.proposedBy.name}{decision.proposedBy.kind === 'agent' ? ' (agent)' : ''} · {shortDate(decision.createdAt)}</dd>
        {decision.decidedBy ? <><dt>Decided</dt><dd>{decision.decidedBy.name} · {shortDate(decision.decidedAt!)}</dd></> : null}
      </dl>

      {earlier ? (
        <section className="details__sec" aria-labelledby="wd-replaces">
          <h4 id="wd-replaces">{decision.status === 'proposed' ? 'Would replace' : 'Replaced'}</h4>
          <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'decision', id: earlier.id })}><span className={earlier.status === 'superseded' ? 'wd-was' : ''}>{earlier.title}</span><Icon name="chevron-right" size={14} /></button>
          {earlier.rationale ? <p className="wd-quote">Earlier reason: {earlier.rationale}</p> : null}
        </section>
      ) : null}
      {later ? (
        <section className="details__sec" aria-labelledby="wd-replaced-by">
          <h4 id="wd-replaced-by">Replaced by</h4>
          <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'decision', id: later.id })}><span>{later.title}</span><Icon name="chevron-right" size={14} /></button>
        </section>
      ) : null}

      <section className="details__sec" aria-labelledby="wd-based">
        <h4 id="wd-based">Based on</h4>
        <Sources links={decision.links} id={decision.id} project={context.project} />
        {!decision.links.some((link) => link.role === 'source') ? <p className="wd-muted">No source linked.</p> : null}
      </section>
      {affected.length ? (
        <section className="details__sec" aria-labelledby="wd-affects">
          <h4 id="wd-affects">Affects</h4>
          <Linked items={affected.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'work', id: entry.id }) }))} />
        </section>
      ) : null}
      {stillApplies.length || parked.length ? (
        <section className="details__sec" aria-labelledby="wd-pivot">
          <h4 id="wd-pivot">At this pivot</h4>
          <Linked items={[
            ...stillApplies.map((entry) => ({ key: entry.link.id, label: entry.title, hint: 'still applies', open: () => openDetails({ kind: 'work', id: entry.id }) })),
            ...parked.map((item) => ({ key: item.id, label: item.title, hint: 'parked', open: () => openDetails({ kind: 'work', id: item.id }) })),
          ]} />
        </section>
      ) : null}

      {decision.status === 'proposed' && !writable ? (
        // O-009 (#250): a reader without write access sees that the proposal is not binding and who decides it.
        <section className="details__sec" aria-labelledby="wd-who-decides">
          <h4 id="wd-who-decides">Who decides</h4>
          <p>Not accepted yet. A person who can edit {context.project.name} accepts it; agents and assistants can only propose.</p>
        </section>
      ) : null}
      {decision.status === 'proposed' && writable ? (
        <form className="details__sec wd-accept" onSubmit={(event) => void accept(event)}>
          <h4>{pivot ? 'Accept as a pivot' : 'Accept'}</h4>
          <p>Accepting makes this the current rule{earlier ? ` in place of “${earlier.title}”, which stays in the history` : ''}. You are recorded as the person who decided.</p>
          {pivot && candidates.length ? (
            <fieldset className="wd-pivot" disabled={busy}>
              <legend>What happens to current work?</legend>
              {candidates.map((item) => (
                <div className="wd-pivot__row" key={item.id} role="radiogroup" aria-label={item.title}>
                  <span className="wd-pivot__t">{item.title}<small>{STATUS_LABEL[item.status]}{item.owner ? ` · ${item.owner.name}` : ''}</small></span>
                  {(['keep', 'park', 'leave'] as const).map((choice) => (
                    <label key={choice} className="wd-pivot__c"><input type="radio" name={`pivot-${item.id}`} value={choice} checked={(choices[item.id] ?? 'leave') === choice}
                      onChange={() => setChoices((current) => ({ ...current, [item.id]: choice }))} />{choice === 'keep' ? 'Still applies' : choice === 'park' ? 'Park' : 'Unchanged'}</label>
                  ))}
                </div>
              ))}
            </fieldset>
          ) : null}
          {error ? <p className="wd-error" role="alert">{error}</p> : null}
          <div className="wd-actions"><Button type="submit" variant="primary" busy={busy}>{pivot ? 'Accept and pivot' : 'Accept decision'}</Button></div>
          <p className="wd-muted">Agents can propose decisions; only people accept them.</p>
        </form>
      ) : null}

      <InDocs object={decision} kind="decision" project={context.project} />
      <Audience project={context.project} />
      <IdsLine>Version {decision.version}{decision.supersedes ? ' · supersedes an earlier rule' : ''}</IdsLine>
    </div>
  );
}

function ResultPanel({ result, context }: { result: WorkResult; context: Context }) {
  const { openDetails } = useShellActions();
  useRegisterLiveHere(null, { ref: { type: 'result', id: result.id, version: 1 }, label: result.title, what: 'result' });
  const about = [...linked(result.links, result.id, 'work', ['about']), ...linked(result.links, result.id, 'decision', ['about'])];
  const related = result.links.filter((link) => link.role === 'related');
  return (
    <div className="details wd">
      <p className={`details__eyebrow wd-eyebrow wd-finding--${result.finding}`}><Icon name="result" size={13} />{resultLine(result)} · {shortDate(result.createdAt)}</p>
      <h3 className="details__title">{result.title}</h3>
      {result.evidence ? <p className="details__lead wd-evidence">{result.evidence}</p> : null}
      <section className="details__sec" aria-labelledby="wd-evidence">
        <h4 id="wd-evidence">Evidence</h4>
        <Sources links={result.links} id={result.id} project={context.project} />
        {!result.links.some((link) => link.role === 'source') && !result.evidence ? <p className="wd-muted">No evidence linked.</p> : null}
      </section>
      <section className="details__sec" aria-labelledby="wd-about">
        <h4 id="wd-about">Reports on</h4>
        <Linked empty="Not linked to work or a decision." items={about.map((entry) => ({ key: entry.link.id, label: entry.title, hint: entry.link.to.type === 'decision' ? 'decision' : 'work', open: () => openDetails({ kind: entry.link.to.type as 'work' | 'decision', id: entry.id }) }))} />
        {related.length ? <p className="wd-muted">{related.length} more {related.length === 1 ? 'link' : 'links'}</p> : null}
      </section>
      <InDocs object={result} kind="result" project={context.project} />
      <Audience project={context.project} />
    </div>
  );
}

function SourcePreview({ view }: { view: WorkFormView }) {
  if (!view.source) return null;
  return <blockquote className="wd-source"><span>From the message</span>{firstLine(view.source.text, 280)}</blockquote>;
}

function ProposeDecision({ view, context }: { view: WorkFormView; context: Context }) {
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const current = context.lists.decisions.filter((item) => item.status === 'accepted');
  const [title, setTitle] = useState(view.source ? firstLine(view.source.text) : '');
  const [rationale, setRationale] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rationaleId = useId();
  const replacesId = useId();
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setAttempt(crypto.randomUUID()); setError(''); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const decision = await proposeDecision(view.projectId, {
        title: title.trim(), rationale, ...(supersedes ? { supersedes } : {}),
        ...(view.source ? { sources: [{ type: 'message', id: view.source.messageId }] } : {}),
        ...(view.workId ? { affects: [view.workId] } : {}),
      }, attempt);
      revalidator.revalidate();
      openDetails({ kind: 'decision', id: decision.id });
    } catch (cause) { setError(readable(cause)); }
    finally { setBusy(false); }
  }

  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="rule" size={13} />New proposal</p>
      <h3 className="details__title">Propose a decision</h3>
      <SourcePreview view={view} />
      <fieldset className="wd-form" disabled={busy}>
        <Input label="Decision" value={title} onChange={(event) => edit(setTitle)(event.target.value)} required maxLength={200} />
        <label htmlFor={rationaleId}>Why</label>
        <textarea id={rationaleId} value={rationale} onChange={(event) => edit(setRationale)(event.target.value)} maxLength={20000} rows={4} placeholder="What makes this the right call" />
        {current.length ? <>
          <label htmlFor={replacesId}>Replaces</label>
          <select id={replacesId} value={supersedes} onChange={(event) => edit(setSupersedes)(event.target.value)}>
            <option value="">Nothing, this is a new rule</option>
            {current.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </> : null}
      </fieldset>
      {error ? <p className="wd-error" role="alert">{error} <button type="button" className="wd-inline" onClick={(event) => void submit(event)}>Retry</button></p> : null}
      <div className="wd-actions"><Button type="submit" variant="primary" busy={busy}>Propose decision</Button></div>
      <p className="wd-muted">A person with write access accepts it. The message stays where it is and links here.</p>
      <Audience project={context.project} />
    </form>
  );
}

function AttachResult({ view, context, reload }: { view: WorkFormView; context: Context; reload: () => void }) {
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const open = context.lists.work.filter((item) => !isFinished(item) || item.id === view.workId);
  const [title, setTitle] = useState(view.source ? firstLine(view.source.text) : '');
  const [finding, setFinding] = useState<'positive' | 'negative' | ''>('');
  const [evidence, setEvidence] = useState('');
  const [workId, setWorkId] = useState(view.workId ?? '');
  const [finishes, setFinishes] = useState(false);
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const evidenceId = useId();
  const workSelectId = useId();
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setAttempt(crypto.randomUUID()); setError(''); };
  const chosen = open.find((item) => item.id === workId);
  const finishable = !!chosen && !chosen.parked && chosen.status !== 'not_pursued';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !finding || busy) { if (!finding) setError('Choose whether the finding is positive or negative.'); return; }
    setBusy(true); setError('');
    try {
      const result = await createResult(view.projectId, {
        title: title.trim(), finding, evidence,
        ...(view.source ? { sources: [{ type: 'message', id: view.source.messageId }] } : {}),
        ...(workId ? { work: [workId], ...(finishes && chosen && finishable ? { finishes: { id: workId, expectedVersion: chosen.version } } : {}) } : {}),
      }, attempt);
      revalidator.revalidate();
      openDetails({ kind: 'result', id: result.id });
    } catch (cause) {
      setError(readable(cause));
      // The work changed meanwhile: show its current state so the author decides again.
      if (cause instanceof ApiError && cause.status === 409) { setAttempt(crypto.randomUUID()); reload(); }
    } finally { setBusy(false); }
  }

  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="result" size={13} />New result</p>
      <h3 className="details__title">Attach a result</h3>
      <SourcePreview view={view} />
      <fieldset className="wd-form" disabled={busy}>
        <Input label="Finding" value={title} onChange={(event) => edit(setTitle)(event.target.value)} required maxLength={200} />
        <div className="wd-seg" role="radiogroup" aria-label="Positive or negative">
          {(['positive', 'negative'] as const).map((value) => (
            <label key={value} className="wd-seg__b"><input type="radio" name="finding" value={value} checked={finding === value} onChange={() => edit(setFinding)(value)} />{value === 'positive' ? 'Positive' : 'Negative'}</label>
          ))}
        </div>
        <label htmlFor={evidenceId}>Evidence</label>
        <textarea id={evidenceId} value={evidence} onChange={(event) => edit(setEvidence)(event.target.value)} maxLength={20000} rows={3} placeholder="Numbers, observations or where to find them" />
        {open.length ? <>
          <label htmlFor={workSelectId}>For work</label>
          <select id={workSelectId} value={workId} onChange={(event) => { edit(setWorkId)(event.target.value); if (!event.target.value) setFinishes(false); }}>
            <option value="">Not linked to work</option>
            {open.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          {chosen && !finishable ? <p className="wd-muted">“{chosen.title}” is parked; bring it back into the plan before a result finishes it.</p> : null}
          {chosen && finishable ? <label className="wd-check"><input type="checkbox" checked={finishes} onChange={(event) => edit(setFinishes)(event.target.checked)} />This finishes “{chosen.title}”</label> : null}
        </> : null}
      </fieldset>
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      <div className="wd-actions"><Button type="submit" variant="primary" busy={busy}>Attach result</Button></div>
      <p className="wd-muted">A negative result is a real outcome: it can finish an experiment.</p>
      <Audience project={context.project} />
    </form>
  );
}
