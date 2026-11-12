import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { NeedsYouItem, ReturnNextStep, WorkItem } from '@flux/contracts';
import { Button, Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery } from '../ui';
import { Face, KIND_WORD } from '../notifications/NeedsYouCard';
import { useNeedsYou } from '../notifications/needsYou';
import { getReturnSummary, saveReturnPoint } from '../returns/api';
import { WaitingSpaces } from '../encryption/LockedSpace';
import { SourceLink } from '../returns/SourceLink';
import { listAssignedWork } from '../work/api';
import { STATUS_LABEL, dueLabel } from '../work/format';
import { useShellData } from './data';
import { useShellActions } from './shellContext';
import { useSmallMoments } from './smallMoments';
import { HomeWorkingAgents, WorkingAssistant } from './WorkingAgent';
import '../notifications/needs-you.css';
import './home.css';
import { RefLink } from '../place/origin';
import { PushOffer } from '../notifications/PushOffer';

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(hour: number) {
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

type Continue =
  | { kind: 'task'; item: WorkItem }
  | { kind: 'step'; step: ReturnNextStep; mark: string | null };

interface HomeReads {
  /** What to continue from; null when there is nothing. */
  value: Continue | null;
  /** How many tasks are yours, your agents' included: "My tasks (N)" on the phone. Null until read. */
  tasks: number | null;
}

/**
 * What Home reads about the person's own work, once: the task you were last on (in progress, newest change), else the next
 * step the return summary suggests (a task that became yours while you were away comes before a decision waiting for you, with
 * its due day, #763 H11-5), else nothing; and how many tasks are yours, for "My tasks (N)".
 */
function useContinue(userId: string, workspaceIds: string[]): HomeReads {
  const [state, setState] = useState<{ userId: string; value: Continue | null; tasks: number | null } | null>(null);
  const spaces = workspaceIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let value: Continue | null = null;
      let tasks: number | null = null;
      const read = await getReturnSummary({ type: 'home' }, controller.signal).catch(() => null);
      // A first visit starts the return point and has nothing to continue from: nothing was shown, so nothing is acknowledged.
      const first = !!read && read.point.savedAt === null;
      if (read && first && !controller.signal.aborted) await saveReturnPoint({ type: 'home' }, read.mark).catch(() => undefined);
      const summary = first ? null : read;
      try {
        const assigned = await listAssignedWork(spaces ? spaces.split(',') : [], 50, controller.signal);
        tasks = assigned.total;
        const active = assigned.items.filter((item) => item.status === 'in_progress').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (active) value = { kind: 'task', item: active };
      } catch { /* the card is optional */ }
      if (!value && summary?.nextStep) value = { kind: 'step', step: summary.nextStep, mark: summary.mark };
      if (!controller.signal.aborted) setState({ userId, value, tasks });
    })();
    return () => controller.abort();
  }, [userId, spaces]);
  const mine = state?.userId === userId ? state : null;
  return { value: mine?.value ?? null, tasks: mine?.tasks ?? null };
}

/** "Continue where you left off" (F-026 P1): where the person last worked, as one row under its own heading. */
function ContinueSection({ reads }: { reads: HomeReads }) {
  const { projects } = useShellData();
  // It is the last thing on Home, so when it arrives nothing above it moves and no space is kept for it (#863 rule 6).
  const { value } = reads;
  if (!value) return null;
  let row: ReactNode;
  if (value.kind === 'task') {
    const { item } = value;
    const project = projects.find((entry) => entry.id === item.projectId)?.name;
    row = (
      <RefLink className="home__row" to={`/projects/${item.projectId}/tasks?open=work:${item.id}`}>
        <span className="nyc__face nyc__face--glyph"><StatusGlyph status={item.status} size={16} /></span>
        <span className="home__row-b">
          <span className="home__row-t">{item.title}</span>
          <span className="home__row-k">{STATUS_LABEL[item.status]} · #{item.number}{project ? ` · ${project}` : ''}</span>
        </span>
        <Icon name="chevron-right" size={16} className="home__row-go" />
      </RefLink>
    );
  } else {
    const { step, mark } = value;
    row = (
      <SourceLink source={step.source} className="home__row" onFollow={() => void saveReturnPoint({ type: 'home' }, mark).catch(() => undefined)}>
        <span className="nyc__face nyc__face--icon"><Icon name="chevron-right" size={16} /></span>
        <span className="home__row-b">
          <span className="home__row-t">{step.text}</span>
          <span className="home__row-k">{step.reason}{step.dueOn ? ` Due ${dueLabel(step.dueOn)}.` : ''}</span>
        </span>
        <Icon name="chevron-right" size={16} className="home__row-go" />
      </SourceLink>
    );
  }
  return (
    <section className="home__continue" aria-labelledby="home-continue">
      <div className="home__sech"><h3 id="home-continue">Continue where you left off</h3></div>
      <ul className="home__rows"><li>{row}</li></ul>
    </section>
  );
}

/** A person's names for a line: "Maja", "Maja and Jonas", "Maja, Jonas and 2 more". */
function nameList(names: string[]) {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(' and ');
  return `${unique.slice(0, 2).join(', ')} and ${unique.length - 2} more`;
}

/**
 * What Home lists of the Inbox (F-026 P1, #865): the first three rows, with every decision that waits folded into one
 * row at the place of the first, so "2 decisions waiting" is one line and never two Accept buttons.
 */
type WaitingRow = { key: string; decisions: NeedsYouItem[] } | { key: string; item: NeedsYouItem };
export function waitingRows(items: NeedsYouItem[], limit = 3): WaitingRow[] {
  const rows: WaitingRow[] = [];
  let decisions: NeedsYouItem[] | null = null;
  for (const item of items) {
    if (item.kind !== 'decision') { rows.push({ key: item.key, item }); continue; }
    if (decisions) { decisions.push(item); continue; }
    decisions = [item];
    rows.push({ key: 'decisions', decisions });
  }
  return rows.slice(0, limit);
}

/** One line of a Home card: a face, two lines of words and the arrow every row ends in. */
function HomeRow({ to, state, face, title, meta, metaFirst = false, onClick }: { to: string; state?: unknown; face: ReactNode; title: ReactNode; meta?: ReactNode; metaFirst?: boolean; onClick?: () => void }) {
  return (
    <li>
      <Link className="home__row" to={to} state={state} onClick={onClick}>
        {face}
        <span className="home__row-b">
          {metaFirst && meta ? <span className="home__row-k">{meta}</span> : null}
          <span className="home__row-t">{title}</span>
          {!metaFirst && meta ? <span className="home__row-k">{meta}</span> : null}
        </span>
        <Icon name="chevron-right" size={16} className="home__row-go" />
      </Link>
    </li>
  );
}

function WaitingItem({ row }: { row: WaitingRow }) {
  if ('decisions' in row) {
    const { decisions } = row;
    const places = [...new Set(decisions.map((item) => item.project?.name).filter((name): name is string => !!name))];
    const from = nameList(decisions.map((item) => item.from?.name).filter((name): name is string => !!name));
    return (
      <HomeRow to="/inbox" state={{ select: decisions[0]!.key }} face={<span className="nyc__face nyc__face--icon"><Icon name="rule" size={16} /></span>}
        title={`${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} waiting`}
        meta={[places.slice(0, 2).join(' · '), from ? `from ${from}` : null].filter(Boolean).join(' · ')} />
    );
  }
  const { item } = row;
  const run = item.assistantChanges ?? null;
  const project = item.project?.name ?? null;
  // A run's changes are always the viewer's own agent's; any other agent in the space can ask, so a question or a suggestion says only "Agent", as the Inbox does.
  const meta = (run ? [run.agentName, 'Your agent', project]
    : [KIND_WORD[item.kind], item.from?.name ?? null, item.from?.kind === 'agent' ? 'Agent' : null, project]).filter(Boolean).join(' · ');
  return <HomeRow to="/inbox" state={{ select: item.key }} face={<Face item={item} />} title={item.title} meta={meta} metaFirst />;
}

/** Home (F-026 §7, P1, #865): the date and a greeting, what waits for you (the top of the Inbox), and where to continue. */
export function Home() {
  const moments = useSmallMoments();
  const { me, workspace, workspaces, projects, lockedWorkspaces } = useShellData();
  const { openCreate } = useShellActions();
  const phone = useMediaQuery(MEDIA.navDrawer);
  const queue = useNeedsYou(me.user.id);
  const now = useMemo(() => new Date(), []);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const rows = waitingRows(queue.items ?? []);
  const workspaceIds = useMemo(() => workspaces.map((space) => space.id), [workspaces]);
  const reads = useContinue(me.user.id, workspaceIds);
  // A person with no space yet gets one first step, not an empty queue and links to empty pages (#763 FT-1, S21).
  // A space waiting to be unlocked is not a first run (F-030, #655).
  const firstRun = projects.length === 0 && !lockedWorkspaces.length && !rows.length;
  const joinedSpace = workspace;

  return (
    <div className="pane-scroll"><div className="pane-in home">
      <p className="home__date">{dateFormat.format(now)}</p>
      <h2 className="home__hello">{greeting(now.getHours())}, {firstName}</h2>

      {/* Without a sidebar (phone) Home carries the working agents with Stop; nothing shows while none works (S13). */}
      {phone ? <><WorkingAssistant /><HomeWorkingAgents /></> : null}

      {firstRun ? (
        <section className="home__card home__first" aria-labelledby="home-first">
          {moments ? <Kreska size={56} expression="hello" /> : null}
          {joinedSpace ? <>
            {/* #763 FT-3, F-037: someone in the company with only Everyone is told how other spaces reach them. */}
            <h3 id="home-first">You’re in {joinedSpace.name}</h3>
            <p>When someone adds you to a space, it appears here at once. You can also start your own.</p>
            {joinedSpace.role === 'guest' ? null : <Button variant="secondary" size="lg" onClick={() => openCreate({ kind: 'space' })}>Start a space</Button>}
          </> : <>
          {/* F-037: an account nobody has invited yet joins through a link from the company's admin. */}
          <h3 id="home-first">You’re not in a company here yet</h3>
          <p>Flux is where a company’s people and agents talk, turn what is said into tasks and decisions, and keep what they learn.</p>
          <p className="home__first-note">Got an invite link? Open it to join your company.</p>
          </>}
        </section>
      ) : (
        <section className="home__need" aria-labelledby="home-need">
          <div className="home__sech">
            <h3 id="home-need">Waiting for you{queue.count ? <span className="home__n">{queue.count}</span> : null}</h3>
            <Link className="home__all" to="/inbox" aria-keyshortcuts="G I">Open Inbox</Link>
          </div>
          {queue.items === null ? <div className="home__card home__quiet" aria-busy="true">Looking at what waits for you…</div>
            : rows.length ? (
              <ul className="home__rows" aria-label="Top of your Inbox">
                {rows.map((row) => <WaitingItem key={row.key} row={row} />)}
              </ul>
            ) : (
              <div className="home__card home__clear">{moments ? <Kreska size={32} expression="done" /> : null}<span>{lockedWorkspaces.length
                ? 'Nothing is waiting for you in your open spaces.' : 'Nothing is waiting for you.'}</span></div>
            )}
          {/* F-030 (#655): a space that waits to be unlocked is not looked into; it says so instead of the queue saying "nothing". */}
          {queue.items === null ? null : <WaitingSpaces />}
        </section>
      )}

      {/* The phone has no sidebar: My tasks and My map are rows under the waiting items, and the tab bar stays at three tabs. */}
      {phone && !firstRun ? (
        <ul className="home__rows home__places" aria-label="Your places">
          <HomeRow to="/tasks" face={<span className="nyc__face nyc__face--icon"><Icon name="tasks" size={16} /></span>}
            title={<>My tasks{reads.tasks === null ? null : <span className="home__n">({reads.tasks})</span>}</>} />
          <HomeRow to="/map" face={<span className="nyc__face nyc__face--icon"><Icon name="map" size={16} /></span>} title="My map" />
        </ul>
      ) : null}

      <ContinueSection reads={reads} />
      {/* The one-time offer to turn notifications on (#1243): last on the page, since it may not come (motion rule 6). */}
      <PushOffer userId={me.user.id} ready={(queue.items ?? []).some((item) => item.kind === 'mention' || item.reason === 'question')} />
    </div></div>
  );
}
