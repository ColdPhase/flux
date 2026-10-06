import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ProjectWorkSummary, ReturnItem, WorkItem } from '@flux/contracts';
import { Button, Icon, Spinner } from '../ui';
import { STATUS_LABEL } from '../work/format';
import { Foot, Item, SourceLink, useReturn } from '../returns/SinceYouLeft';
import { useAssignedWork } from './HomeTasks';
import { useShellData, type ProjectSummary } from './data';
import { getProjectWorkSummary } from '../work/read-api';
import './home.css';

const dateLine = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
/** How many rows each Home section shows before its "all" link. */
const SHOWN = 5;
/** Project cards on Home; each reads one bounded summary, so the rest stay on the Projects page. */
const PROJECT_CARDS = 8;

/**
 * Home (#272 FF-2): the place to get back to work. One next step with its reason, the work you own,
 * what needs you, and your projects. Every row says what it is and why it is here, and opens its
 * source (FF-1). Private notes and sketches live in My sketchbook (FF-3); Inbox keeps every
 * notification.
 */
export function HomeView() {
  const { me, projects } = useShellData();
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const { summary, ack, acknowledge } = useReturn({ type: 'home' });
  // After "I have the context" the list closes and focus moves to the Home heading (#190 A1.3); the status
  // line in For you says what happened.
  useEffect(() => {
    if (ack !== 'done') return;
    const heading = document.querySelector<HTMLElement>('header.top h1');
    if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading?.focus();
  }, [ack]);
  const work = useAssignedWork();
  const mine = work?.items ?? [];
  const moving = mine.filter((item) => item.status === 'in_progress' || item.status === 'blocked');
  const needs = (summary?.items ?? []).filter((item) => item.needsYou && item.id !== summary?.nextStep?.item);
  const updates = summary?.point.savedAt ? (summary.items ?? []).filter((item) => !item.needsYou && item.id !== summary.nextStep?.item) : [];
  // Each project's current state, read once per visit: decisions waiting for the reader show in For you,
  // and each card says what the project's own state line says (FF-1).
  const [states, setStates] = useState<Map<string, ProjectWorkSummary>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(projects.slice(0, PROJECT_CARDS).map((project) => getProjectWorkSummary(project.id, controller.signal).then((read) => [project.id, read] as const, () => null)))
      .then((reads) => { if (!controller.signal.aborted) setStates(new Map(reads.filter((read): read is readonly [string, ProjectWorkSummary] => !!read))); });
    return () => controller.abort();
  }, [projects]);
  const listed = new Set((summary?.items ?? []).map((item) => `${item.source.type}:${'id' in item.source ? item.source.id : ''}`));
  const decisions = projects.flatMap((project) => {
    const state = states.get(project.id);
    const proposal = state?.access !== 'viewer' ? state?.state.proposal : null;
    return proposal && !listed.has(`decision:${proposal.id}`) ? [{ project, proposal }] : [];
  });
  const waiting = (summary?.needsYou ?? 0) + decisions.length;
  const toForYou = () => {
    const heading = document.getElementById('home-for-you');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    heading.focus({ preventScroll: true });
  };
  const needsByProject = new Map<string, number>();
  for (const item of summary?.items ?? []) if (item.needsYou && item.project) needsByProject.set(item.project.id, (needsByProject.get(item.project.id) ?? 0) + 1);

  return (
    <div className="pane-scroll">
      <div className="home">
        <div className="home__hello">
          <p className="home__date">{dateLine.format(new Date())}</p>
          <h2 className="home__hi">Hi, {firstName}.</h2>
          {/* What waits for the reader is said at once, on every size (visual review of #275): For you can be
              below the first screen on a phone, so this line goes there. */}
          <p className="home__lead">{waiting
            ? <button type="button" className="home__waiting" onClick={toForYou}><span className="since__dot since__dot--need" aria-hidden="true" />{waitingText(summary?.needsYou ?? 0, decisions.length)}<Icon name="chevron-down" size={14} /></button>
            : 'Your place to get back to work.'}</p>
        </div>

        <ReturnCard summaryStep={summary?.nextStep ?? null} moving={moving[0] ?? null} projectName={(id) => projects.find((project) => project.id === id)?.name ?? 'Project'} />

        <div className="home__cols">
          <MyWork items={mine} moving={moving} loading={!work} failed={!!work?.failed} total={work?.total ?? 0} projectName={(id) => work?.names.get(id) ?? 'Project'} />

          <section className="home-sec" aria-labelledby="home-for-you">
            <div className="home-sec__head">
              <h3 id="home-for-you" className="home-sec__h">For you</h3>
              {waiting ? <span className="home-sec__count" aria-label={`${waiting} ${waiting === 1 ? 'needs' : 'need'} you`}>{waiting}</span> : null}
            </div>
            <p className="home-sec__why">Replies, mentions and requests that wait for you, across your projects.</p>
            {decisions.length ? (
              <ul className="since__list" aria-label="Decisions waiting for you">
                {decisions.map(({ project, proposal }) => (
                  <li key={proposal.id}>
                    <Link className="since__item is-need" to={`/projects/${project.id}?open=decision:${proposal.id}`}>
                      <span className="since__dot since__dot--need" aria-hidden="true" />
                      <span className="since__body">
                        <span className="since__text">Decide: {proposal.title}</span>
                        <span className="since__detail">{project.name} · proposed, waiting for your decision</span>
                      </span>
                      <Icon name="chevron-right" size={14} className="since__go" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {ack === 'done' ? <p className="home-sec__empty" role="status">You’re caught up. New things for you will show here.</p>
              : !summary ? <div className="home-sec__wait"><Spinner label="Loading what needs you" /></div>
                : needs.length || updates.length ? (
                  <>
                    {needs.length ? <ul className="since__list">{needs.slice(0, SHOWN).map((item) => <Item key={item.id} item={item} showProject />)}</ul> : decisions.length ? null : <p className="home-sec__empty">Nothing needs you right now.</p>}
                    {updates.length ? (
                      <>
                        <h4 className="home-sec__sub">Other changes since you were last here</h4>
                        <ul className="since__list">{updates.slice(0, SHOWN).map((item) => <Item key={item.id} item={item} showProject />)}</ul>
                      </>
                    ) : null}
                    <Foot summary={summary} ack={ack} onAcknowledge={() => void acknowledge()} />
                  </>
                ) : decisions.length ? null : <p className="home-sec__empty">Nothing needs you right now. When someone replies to you, mentions you or asks for your decision, it shows here and in your Inbox.</p>}
            <Link className="home-sec__all" to="/inbox">Open Inbox<Icon name="chevron-right" size={14} /></Link>
          </section>
        </div>

        <section className="home-sec home-sec--projects" aria-labelledby="home-projects">
          <div className="home-sec__head"><h3 id="home-projects" className="home-sec__h">Your projects</h3></div>
          {projects.length ? (
            <ul className="home-projects">
              {projects.slice(0, PROJECT_CARDS).map((project) => <ProjectCard key={project.id} project={project} needs={needsByProject.get(project.id) ?? 0} summary={states.get(project.id) ?? null} />)}
            </ul>
          ) : <p className="home-sec__empty">You are not in a project yet. Start one, or it appears here when someone adds you.</p>}
          <div className="home-sec__row">
            {projects.length > PROJECT_CARDS ? <Link className="home-sec__all" to="/projects">All {projects.length} projects<Icon name="chevron-right" size={14} /></Link> : null}
            <Link className="home-sec__all" to="/projects/new"><Icon name="plus" size={14} />New project</Link>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * One project on Home (FF-2): its goal, and what is happening there in the same words as the project's
 * own state line, so Home and the project never disagree about what needs you.
 */
function ProjectCard({ project, needs, summary }: { project: ProjectSummary; needs: number; summary: ProjectWorkSummary | null }) {
  const decide = !!summary?.state.proposal && summary.access !== 'viewer';
  const [line, need] = decide ? ['A decision needs you', true]
    : needs ? [`${needs} ${needs === 1 ? 'thing needs' : 'things need'} you`, true]
      : summary?.state.blocked.count ? [`${summary.state.blocked.count} blocked`, false]
        : summary?.state.active.count ? [`${summary.state.active.count} in progress`, false]
          : summary?.unfinishedTotal ? [`${summary.unfinishedTotal} open ${summary.unfinishedTotal === 1 ? 'task' : 'tasks'}`, false]
            : summary ? ['Nothing open', false] : [project.hasNew ? 'New activity' : '', false];
  return (
    <li className="home-project">
      <Link className="home-project__open" to={`/projects/${project.id}`}>
        <span className="home-project__ic" aria-hidden="true"><Icon name="spark" size={16} /></span>
        <span className="home-project__body">
          <span className="home-project__name">{project.name}</span>
          {project.goal ? <span className="home-project__goal">{project.goal}</span> : null}
          <span className={`home-project__state${need ? ' is-need' : ''}`}>{line}</span>
        </span>
        <Icon name="chevron-right" size={14} className="home-project__go" />
      </Link>
      <Link className="home-project__recap" to={`/projects/${project.id}?open=recap`}><Icon name="leaf" size={13} />What matters</Link>
    </li>
  );
}

/**
 * The return point (FF-2): Flux's next step with its reason, or else the task you were moving, or
 * else a calm "caught up" with the two places to start from.
 */
function ReturnCard({ summaryStep, moving, projectName }: {
  summaryStep: { text: string; reason: string; source: ReturnItem['source'] } | null;
  moving: WorkItem | null;
  projectName: (id: string) => string;
}) {
  if (summaryStep) {
    const projectId = 'projectId' in summaryStep.source ? summaryStep.source.projectId : null;
    return (
      <section className="home-return" aria-labelledby="home-return-h">
        <p className="home-return__k"><Icon name="spark" size={13} />Your next step</p>
        <h3 id="home-return-h" className="home-return__title">{summaryStep.text}</h3>
        <p className="home-return__why">{summaryStep.reason}</p>
        {projectId ? <p className="home-return__where">{projectName(projectId)}</p> : null}
        <SourceLink source={summaryStep.source} className="ui-btn ui-btn--primary home-return__go">Back to work<Icon name="chevron-right" size={14} /></SourceLink>
      </section>
    );
  }
  if (moving) {
    return (
      <section className="home-return" aria-labelledby="home-return-h">
        <p className="home-return__k"><Icon name="spark" size={13} />Pick up where you left off</p>
        <h3 id="home-return-h" className="home-return__title">{moving.title}</h3>
        <p className="home-return__why">{moving.status === 'blocked' ? `Blocked: ${moving.blocker || 'no reason was recorded.'}` : 'You own this task and it is in progress.'}</p>
        <p className="home-return__where">{projectName(moving.projectId)}</p>
        <Link className="ui-btn ui-btn--primary home-return__go" to={`/projects/${moving.projectId}/tasks?open=work:${moving.id}`}>Back to work<Icon name="chevron-right" size={14} /></Link>
      </section>
    );
  }
  return (
    <section className="home-return home-return--calm" aria-labelledby="home-return-h">
      <p className="home-return__k"><Icon name="check" size={13} />All caught up</p>
      <h3 id="home-return-h" className="home-return__title">Nothing is waiting for you</h3>
      <p className="home-return__why">Start from a project, or jot a private note that only you can see.</p>
      <div className="home-return__row">
        <Link className="ui-btn ui-btn--secondary" to="/projects">Your projects</Link>
        <Link className="ui-btn ui-btn--quiet" to="/notes"><Icon name="edit" size={14} />Write a note</Link>
      </div>
    </section>
  );
}

/** "1 decision needs you", "3 things need you": what For you holds, in one line. */
function waitingText(needs: number, decisions: number) {
  const total = needs + decisions;
  const what = needs ? (total === 1 ? 'thing' : 'things') : (total === 1 ? 'decision' : 'decisions');
  return `${total} ${what} ${total === 1 ? 'needs' : 'need'} you`;
}

function MyWork({ items, moving, loading, failed, total, projectName }: {
  items: WorkItem[]; moving: WorkItem[]; loading: boolean; failed: boolean; total: number; projectName: (id: string) => string;
}) {
  const [all, setAll] = useState(false);
  const shown = (all ? items : moving).slice(0, SHOWN);
  return (
    <section className="home-sec" aria-labelledby="home-work">
      <div className="home-sec__head">
        <h3 id="home-work" className="home-sec__h">My work</h3>
        <div className="home-seg" role="group" aria-label="Which tasks">
          <button type="button" className="home-seg__b" aria-pressed={!all} onClick={() => setAll(false)}>Active · {moving.length}</button>
          <button type="button" className="home-seg__b" aria-pressed={all} onClick={() => setAll(true)}>All · {total || items.length}</button>
        </div>
      </div>
      <p className="home-sec__why">{all ? 'Every open task you own, in every project.' : 'Tasks you own that are in progress or blocked.'} Other people’s tasks stay in each project.</p>
      {loading ? <div className="home-sec__wait"><Spinner label="Loading your tasks" /></div>
        : failed && !items.length ? <p className="home-sec__empty" role="alert">Your tasks could not be loaded. Nothing was lost; open this page again to retry.</p>
          : shown.length ? (
            <ul className="home-work">
              {shown.map((item) => (
                <li key={item.id}>
                  <Link className="home-work__item" to={`/projects/${item.projectId}/tasks?open=work:${item.id}`}>
                    <span className={`home-work__dot is-${item.status}`} aria-hidden="true" />
                    <span className="home-work__body">
                      <span className="home-work__title">{item.title}</span>
                      <span className="home-work__meta">{projectName(item.projectId)} · {STATUS_LABEL[item.status]}{item.status === 'blocked' ? ` · ${item.blocker || 'no reason recorded'}` : ''}</span>
                    </span>
                    <Icon name="chevron-right" size={14} className="home-work__go" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="home-sec__empty">{all ? 'You own no open tasks. When someone gives you a task, it shows here.' : 'Nothing of yours is in progress.'}{!all && items.length ? <> <Button variant="quiet" onClick={() => setAll(true)}>Show all {items.length}</Button></> : null}</p>}
      <Link className="home-sec__all" to="/tasks">All my tasks<Icon name="chevron-right" size={14} /></Link>
    </section>
  );
}
