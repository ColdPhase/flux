import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ReturnNextStep, WorkItem } from '@flux/contracts';
import { Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery } from '../ui';
import { NeedsYouCard } from '../notifications/NeedsYouCard';
import { useNeedsYou } from '../notifications/needsYou';
import { useNeedsYouActions } from '../notifications/useNeedsYouActions';
import { getReturnSummary, saveReturnPoint } from '../returns/api';
import { SourceLink } from '../returns/SinceYouLeft';
import { listAssignedWork } from '../work/api';
import { STATUS_LABEL } from '../work/format';
import { useShellData } from './data';
import { WorkingAgent } from './WorkingAgent';
import '../notifications/needs-you.css';
import './home.css';

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(hour: number) {
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

type Continue =
  | { kind: 'task'; item: WorkItem }
  | { kind: 'step'; step: ReturnNextStep; mark: string | null };

/**
 * Where to continue (P1): the task you were last on (in progress, newest change), else the next step
 * "Since you left" suggests (F5: the return contract feeds this card), else nothing.
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
      <Link className="home__card home__continue" to={`/projects/${item.projectId}/tasks?open=work:${item.id}`}>
        <span className="home__k">Continue where you left off</span>
        <span className="home__t">{item.title}</span>
        <span className="home__sub"><StatusGlyph status={item.status} size={14} /><span>{STATUS_LABEL[item.status]} · #{item.number}{project ? ` · ${project}` : ''}</span></span>
        {arrow}
      </Link>
    );
  }
  const { step, mark } = value;
  return (
    <SourceLink source={step.source} className="home__card home__continue" onFollow={() => void saveReturnPoint({ type: 'home' }, mark).catch(() => undefined)}>
      <span className="home__k">Continue where you left off</span>
      <span className="home__t">{step.text}</span>
      <span className="home__sub"><span>{step.reason}</span></span>
      {arrow}
    </SourceLink>
  );
}

/** Home (F-026 §7, S1, P1): the date and a greeting, the top three that need you, where to continue, and your projects. */
export function Home() {
  const { me, workspaces, projects } = useShellData();
  const phone = useMediaQuery(MEDIA.navDrawer);
  const queue = useNeedsYou(me.user.id);
  const handlers = useNeedsYouActions(queue);
  const [menu, setMenu] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const top = (queue.items ?? []).slice(0, 3);
  const workspaceIds = useMemo(() => workspaces.map((space) => space.id), [workspaces]);

  return (
    <div className="pane-scroll"><div className="pane-in home">
      <p className="home__date">{dateFormat.format(now)}</p>
      <h2 className="home__hello">{greeting(now.getHours())}, {firstName}</h2>

      {phone ? <ContinueCard userId={me.user.id} workspaceIds={workspaceIds} /> : null}
      {phone ? <WorkingAgent /> : null}

      <section className="home__need" aria-labelledby="home-need">
        <div className="home__sech">
          <h3 id="home-need">Needs you{queue.count ? <span className="home__n">{queue.count}</span> : null}</h3>
          <Link className="home__all" to="/inbox" aria-keyshortcuts="G I">{phone ? 'See all' : 'Open Inbox'}{phone ? <Icon name="chevron-right" size={14} /> : <span aria-hidden="true"><kbd>G</kbd><kbd>I</kbd></span>}</Link>
        </div>
        {queue.items === null ? <div className="home__card home__quiet" aria-busy="true">Looking at what needs you…</div>
          : top.length ? (
            <ul className="home__queue" aria-label="Top of your Inbox">
              {top.map((item) => (
                <NeedsYouCard key={item.key} item={item} variant="row" handlers={handlers} menuOpen={menu === item.key} onMenuOpen={(open) => setMenu(open ? item.key : null)} />
              ))}
            </ul>
          ) : (
            <div className="home__card home__clear"><Kreska size={32} expression="done" /><span>Nothing needs you right now. Enjoy the quiet.</span></div>
          )}
      </section>

      <div className="home__pair">
        {!phone ? <ContinueCard userId={me.user.id} workspaceIds={workspaceIds} /> : null}
        <section className="home__card home__projects" aria-labelledby="home-projects">
          <h3 id="home-projects" className="home__k">Projects</h3>
          {projects.length ? (
            <ul>
              {projects.slice(0, 5).map((project) => (
                <li key={project.id}>
                  <Link to={`/projects/${project.id}`} className="home__project">
                    <span className="home__tile" aria-hidden="true">{(project.name.trim()[0] ?? '?').toUpperCase()}</span>
                    <span className="home__pn">{project.name}</span>
                    <span className={`home__state${project.hasNew ? ' is-new' : ''}`}>{project.hasNew ? 'new' : 'quiet'}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="home__empty">No projects yet. <Link to="/projects/new">Create one</Link> with the New button.</p>}
        </section>
      </div>

      <p className="home__keys" aria-hidden="true">
        <span><kbd>C</kbd> new</span><span><kbd>⌘K</kbd> search or run</span><span><kbd>G</kbd><kbd>I</kbd> Inbox</span><span><kbd>[</kbd> hide sidebar</span>
      </p>
    </div></div>
  );
}
