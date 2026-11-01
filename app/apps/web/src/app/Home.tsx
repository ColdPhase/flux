import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ReturnNextStep, WorkItem } from '@flux/contracts';
import { Button, Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery } from '../ui';
import { MeetAssistantCard } from '../assistant/MeetAssistant';
import { MorningLine } from '../assistant/MorningLine';
import { NeedsYouCard } from '../notifications/NeedsYouCard';
import { useNeedsYou } from '../notifications/needsYou';
import { useNeedsYouActions } from '../notifications/useNeedsYouActions';
import { getReturnSummary, saveReturnPoint } from '../returns/api';
import { WaitingSpaces } from '../encryption/LockedSpace';
import { SourceLink } from '../returns/SinceYouLeft';
import { listAssignedWork } from '../work/api';
import { STATUS_LABEL, dueLabel } from '../work/format';
import { useShellData } from './data';
import { useShellActions } from './shellContext';
import { useSmallMoments } from './smallMoments';
import { useProjectNews } from './projectNews';
import { HomeWorkingAgents, WorkingAssistant } from './WorkingAgent';
import '../notifications/needs-you.css';
import './home.css';
import { RefLink } from '../place/origin';

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(hour: number) {
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

type Continue =
  | { kind: 'task'; item: WorkItem }
  | { kind: 'step'; step: ReturnNextStep; mark: string | null };

/**
 * Where to continue (P1): the task you were last on (in progress, newest change), else the next step
 * "Since you left" suggests (F5: the return contract feeds this card; a task that became yours while you were away
 * comes before a rule waiting for you, with its due day, #763 H11-5), else nothing.
 */
function useContinue(userId: string, workspaceIds: string[]): { value: Continue | null; ready: boolean } {
  const [state, setState] = useState<{ userId: string; value: Continue | null } | null>(null);
  const spaces = workspaceIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let value: Continue | null = null;
      const read = await getReturnSummary({ type: 'home' }, controller.signal).catch(() => null);
      // A first visit starts the return point and has nothing to continue from: nothing was shown, so nothing is acknowledged.
      const first = !!read && read.point.savedAt === null;
      if (read && first && !controller.signal.aborted) await saveReturnPoint({ type: 'home' }, read.mark).catch(() => undefined);
      const summary = first ? null : read;
      try {
        const assigned = await listAssignedWork(spaces ? spaces.split(',') : [], 50, controller.signal);
        const active = assigned.items.filter((item) => item.status === 'in_progress').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (active) value = { kind: 'task', item: active };
      } catch { /* the card is optional */ }
      if (!value && summary?.nextStep) value = { kind: 'step', step: summary.nextStep, mark: summary.mark };
      if (!controller.signal.aborted) setState({ userId, value });
    })();
    return () => controller.abort();
  }, [userId, spaces]);
  return { value: state?.userId === userId ? state.value : null, ready: state?.userId === userId };
}

function ContinueCard({ userId, workspaceIds }: { userId: string; workspaceIds: string[] }) {
  const { projects } = useShellData();
  const { value, ready } = useContinue(userId, workspaceIds);
  if (!ready || !value) return null;
  const arrow = <span className="home__go" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>;
  if (value.kind === 'task') {
    const { item } = value;
    const project = projects.find((entry) => entry.id === item.projectId)?.name;
    return (
      <RefLink className="home__card home__continue" to={`/projects/${item.projectId}/tasks?open=work:${item.id}`}>
        <span className="home__k">Continue where you left off</span>
        <span className="home__t">{item.title}</span>
        <span className="home__sub"><StatusGlyph status={item.status} size={14} /><span>{STATUS_LABEL[item.status]} · #{item.number}{project ? ` · ${project}` : ''}</span></span>
        {arrow}
      </RefLink>
    );
  }
  const { step, mark } = value;
  return (
    <SourceLink source={step.source} className="home__card home__continue" onFollow={() => void saveReturnPoint({ type: 'home' }, mark).catch(() => undefined)}>
      <span className="home__k">Continue where you left off</span>
      <span className="home__t">{step.text}</span>
      <span className="home__sub"><span>{step.reason}{step.dueOn ? ` Due ${dueLabel(step.dueOn)}.` : ''}</span></span>
      {arrow}
    </SourceLink>
  );
}

/** Home (F-026 §7, S1, P1): the date and a greeting, the top three that need you, where to continue, and your projects. */
export function Home() {
  const moments = useSmallMoments();
  const { me, workspaces, projects, lockedWorkspaces } = useShellData();
  const { openDetails, openCreate } = useShellActions();
  const phone = useMediaQuery(MEDIA.navDrawer);
  const queue = useNeedsYou(me.user.id);
  const handlers = useNeedsYouActions(queue);
  const [menu, setMenu] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const top = (queue.items ?? []).slice(0, 3);
  const workspaceIds = useMemo(() => workspaces.map((space) => space.id), [workspaces]);
  const news = useProjectNews(useMemo(() => projects.slice(0, 5).map((project) => project.id), [projects]));
  // A person with no project yet gets one first step, not an empty queue and links to empty pages (#763 FT-1, S21).
  // A space waiting to be unlocked is not a first run: its row stays in Projects (F-030, #655).
  const firstRun = projects.length === 0 && !lockedWorkspaces.length && !top.length;
  const joinedSpace = workspaces.find((space) => space.role !== null && space.role !== 'owner') ?? null;

  return (
    <div className="pane-scroll"><div className="pane-in home">
      <p className="home__date">{dateFormat.format(now)}</p>
      <h2 className="home__hello">{greeting(now.getHours())}, {firstName}</h2>
      <MorningLine />

      {phone ? <ContinueCard userId={me.user.id} workspaceIds={workspaceIds} /> : null}
      {/* Without a sidebar (phone, narrow drawer) Home carries the working agents with Stop, under Continue as drawn (S13). */}
      {phone ? <><WorkingAssistant /><HomeWorkingAgents /></> : null}

      {firstRun ? (
        <section className="home__card home__first" aria-labelledby="home-first">
          {moments ? <Kreska size={56} expression="hello" /> : null}
          {joinedSpace ? <>
            {/* #763 FT-3: someone who joined a space but has no project there yet is told so, not sent to an invite link. */}
            <h3 id="home-first">You joined {joinedSpace.name}</h3>
            <p>Nobody has added you to a project there yet. A project’s manager gives you access, and it appears here at once. You can also start your own.</p>
            <Button variant="secondary" size="lg" onClick={() => openCreate({ kind: 'project' })}>Start your own project</Button>
          </> : <>
          <h3 id="home-first">Start with a project</h3>
          <p>A project is where people and agents talk, turn what is said into tasks and decisions, and keep what they learn.</p>
          <Button variant="primary" size="lg" onClick={() => openCreate({ kind: 'project' })}>Start your first project</Button>
          <p className="home__first-note">Got an invite link? Open it to join your team.</p>
          </>}
        </section>
      ) : null}
      {/* Details (the space and its people, where invite links are made) stays reachable; the links to empty pages wait. */}
      {/* Where to continue stays: it is empty for someone with nothing yet, and shows what a shared space already holds. */}
      {firstRun && !phone ? <ContinueCard userId={me.user.id} workspaceIds={workspaceIds} /> : null}
      {firstRun && workspaces.length ? <p className="home__more"><button type="button" onClick={() => openDetails()}>Details</button></p> : null}
      {firstRun ? null : <>
      <section className="home__need" aria-labelledby="home-need">
        <div className="home__sech">
          <h3 id="home-need">Needs you{queue.count ? <span className="home__n">{queue.count}</span> : null}</h3>
          <Link className="home__all" to="/inbox" aria-keyshortcuts="G I">{phone ? 'See all' : 'Open Inbox'}{phone ? <Icon name="chevron-right" size={14} /> : <span aria-hidden="true"><kbd>G</kbd><kbd>I</kbd></span>}</Link>
        </div>
        {queue.items === null ? <div className="home__card home__quiet" aria-busy="true">Looking at what needs you…</div>
          : top.length ? (
            <ul className="home__queue" aria-label="Top of your Inbox">
              {top.map((item, index) => (
                <NeedsYouCard key={item.key} item={item} variant="row" lead={index === 0} handlers={handlers} menuOpen={menu === item.key} onMenuOpen={(open) => setMenu(open ? item.key : null)} />
              ))}
            </ul>
          ) : (
            <div className="home__card home__clear">{moments ? <Kreska size={32} expression="done" /> : null}<span>{lockedWorkspaces.length
              ? 'Nothing needs you in your open spaces.' : 'Nothing needs you right now. Enjoy the quiet.'}</span></div>
          )}
        {/* F-030 (#655): a space that waits to be unlocked is not looked into; it says so instead of the queue saying "nothing". */}
        {queue.items === null ? null : <WaitingSpaces />}
      </section>

      <div className="home__pair">
        {!phone ? <ContinueCard userId={me.user.id} workspaceIds={workspaceIds} /> : null}
        <section className="home__card home__projects" aria-labelledby="home-projects">
          <h3 id="home-projects" className="home__k">Projects</h3>
          {projects.length || lockedWorkspaces.length ? (
            <ul>
              {projects.slice(0, 5).map((project) => (
                <li key={project.id}>
                  <Link to={`/projects/${project.id}`} className="home__project">
                    <span className="home__tile" aria-hidden="true">{(project.name.trim()[0] ?? '?').toUpperCase()}</span>
                    <span className="home__pn">{project.name}</span>
                    <span className={`home__state${news.has(project.id) ? ' is-new' : ''}`}>{news.has(project.id) ? 'new' : 'quiet'}</span>
                  </Link>
                </li>
              ))}
              {/* An encrypted space that waits to be unlocked is one row in place of its projects (F-030, #655). */}
              {lockedWorkspaces.map((space) => (
                <li key={space.id}>
                  <Link to={`/spaces/${space.id}`} className="home__project home__project--locked" data-locked-space={space.id}>
                    <span className="home__tile" aria-hidden="true"><Icon name="lock" size={12} /></span>
                    <span className="home__pn">{space.name}</span>
                    <span className="home__state">Waiting to be unlocked</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="home__empty">No projects yet. When someone adds you to one, it appears here.</p>}
        </section>
      </div>

      <MeetAssistantCard userId={me.user.id} />

      <p className="home__more"><Link to="/tasks">All my tasks</Link><Link to="/map">Sketchbook</Link><Link to="/docs">Wiki</Link><button type="button" onClick={() => openDetails()}>Details</button></p>
      </>}

      <p className="home__keys" aria-hidden="true">
        <span><kbd>C</kbd> new</span><span><kbd>⌘K</kbd> search or run</span><span><kbd>G</kbd><kbd>I</kbd> Inbox</span><span><kbd>[</kbd> hide sidebar</span>
      </p>
    </div></div>
  );
}
