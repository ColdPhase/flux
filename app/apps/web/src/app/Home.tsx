import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { NeedsYouItem, ReturnNextStep, WorkItem } from '@flux/contracts';
import { Button, Icon, Kreska, MEDIA, StatusGlyph, useMediaQuery, useToast } from '../ui';
import { Face, kindWord } from '../notifications/NeedsYouCard';
import { bareAgent, fromWords, useNeedsYou } from '../notifications/needsYou';
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
import { enablePushNotifications, getPushState } from '../pwa/push';
import type { AgentRuntimeClient, FirstStep, FirstStepJoined, FirstSteps as FirstStepsRead } from '@flux/contracts';
import { openDm } from '../api/direct-messages';
import { awaitField, stopAwaitingField } from '../ui/keys';
import { attemptKeys, firstName, startsSpaces } from '../people/api';
import { getFirstSteps, hideFirstSteps } from './firstSteps';
import { onPlacesForgotten } from '../place/memory';

const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

function greeting(hour: number) {
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

type Continue =
  | { kind: 'task'; item: WorkItem }
  | { kind: 'step'; step: ReturnNextStep; mark: string | null };

interface HomeReads {
  /** What to continue from, best first: the task in progress, then the return summary's next step. Empty when there is nothing. */
  choices: Continue[];
  /** How many tasks are yours, your agents' included: "My tasks (N)" on the phone. Null until read. */
  tasks: number | null;
  /** Nothing to continue from could be read: said under its heading, with Try again, never left out as if there were nothing (#1369). */
  failed: boolean;
  reload: () => void;
}

/**
 * What Home reads about the person's own work, once: the task you were last on (in progress, newest change), then the next
 * step the return summary suggests (a task that became yours while you were away comes before a decision waiting for you, with
 * its due day, #763 H11-5), best first, and how many tasks are yours, for "My tasks (N)". Home shows the first one that
 * "Waiting for you" does not already show (#1424).
 */
/** Home's last good read in this tab, for the one person who read it: offline, Home shows it as the line above promises (round 15). */
let lastContinue: { userId: string; choices: Continue[]; tasks: number | null } | null = null;
/** The first steps this tab last read: a read that fails (offline) keeps them, so they never leave and stay gone (round 15 look-1 P2-5). */
let lastFirstSteps: { userId: string; read: FirstStepsRead } | null = null;
onPlacesForgotten(() => { lastContinue = null; lastFirstSteps = null; });

function useContinue(userId: string, workspaceIds: string[]): HomeReads {
  const [state, setState] = useState<{ userId: string; choices: Continue[]; tasks: number | null; failed: boolean } | null>(
    () => lastContinue?.userId === userId ? { ...lastContinue, failed: false } : null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const spaces = workspaceIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const choices: Continue[] = [];
      let tasks: number | null = null;
      let failed = false;
      const read = await getReturnSummary({ type: 'home' }, controller.signal).catch(() => { failed = true; return null; });
      // A first visit starts the return point and has nothing to continue from: nothing was shown, so nothing is acknowledged.
      const first = !!read && read.point.savedAt === null;
      if (read && first && !controller.signal.aborted) await saveReturnPoint({ type: 'home' }, read.mark).catch(() => undefined);
      const summary = first ? null : read;
      try {
        const assigned = await listAssignedWork(spaces ? spaces.split(',') : [], 50, controller.signal);
        // A read that failed in part is no count: "My tasks (0)" is never said for tasks that could not be read (round 15 look-1 P2-5).
        if (assigned.failed) failed = true; else tasks = assigned.total;
        const active = assigned.items.filter((item) => item.status === 'in_progress').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (active) choices.push({ kind: 'task', item: active });
      } catch { failed = true; }
      if (summary?.nextStep) choices.push({ kind: 'step', step: summary.nextStep, mark: summary.mark });
      if (controller.signal.aborted) return;
      // What could not be read now is what this tab last read, while there is one (offline: "Flux shows what it last loaded").
      const kept = failed && lastContinue?.userId === userId ? lastContinue : null;
      if (kept) { setState({ ...kept, failed: false }); return; }
      if (!failed) lastContinue = { userId, choices, tasks };
      setState({ userId, choices, tasks, failed: failed && !choices.length });
    })();
    return () => controller.abort();
  }, [userId, spaces, attempt]);
  // Back online, Home reads again by itself (round 14, look-a A7).
  useEffect(() => { window.addEventListener('online', reload); return () => window.removeEventListener('online', reload); }, [reload]);
  const mine = state?.userId === userId ? state : null;
  return { choices: mine?.choices ?? [], tasks: mine?.tasks ?? null, failed: mine?.failed ?? false, reload };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The ids of the things a Home choice points at: the task, or what its next step's source names. */
function continueIds(choice: Continue): string[] {
  if (choice.kind === 'task') return [choice.item.id];
  const { source } = choice.step;
  switch (source.type) {
    case 'message': return [source.messageId];
    case 'material': return [source.materialId];
    case 'sketch': return [source.sketchId];
    case 'doc': return [source.docId];
    default: return [source.id];
  }
}

/**
 * The ids of everything the rows of "Waiting for you" stand for: a decision, the task a blocked item is about, an agent's
 * question and its message, and any id in the address a row opens (a mention's message). Continue never shows one of them again (#1424).
 */
export function waitingIds(rows: WaitingRow[]): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) ids.add(id.toLowerCase()); };
  for (const row of rows) {
    for (const item of 'decisions' in row ? row.decisions : [row.item]) {
      add(item.decision?.id); add(item.blocked?.workId); add(item.agentQuestion?.messageId); add(item.agentQuestion?.task?.id);
      for (const id of `${item.key} ${item.url}`.match(UUID) ?? []) add(id);
    }
  }
  return ids;
}

/**
 * "Continue where you left off" (F-026 P1): where the person last worked, as one row under its own heading. Something that
 * "Waiting for you" shows already is not shown again; `covered` is null while that list is still loading, so the row
 * does not appear and then leave.
 */
function ContinueSection({ reads, covered }: { reads: HomeReads; covered: Set<string> | null }) {
  const { projects } = useShellData();
  // It is the last thing on Home, so when it arrives nothing above it moves and no space is kept for it (#863 rule 6).
  const value = covered ? reads.choices.find((choice) => !continueIds(choice).some((id) => covered.has(id.toLowerCase()))) ?? null : null;
  if (!value && reads.failed && covered) {
    return (
      <section className="home__continue" aria-labelledby="home-continue">
        <div className="home__sech"><h3 id="home-continue">Continue where you left off</h3></div>
        <div className="home__card home__quiet" role="alert">This couldn’t be loaded. <Button variant="link" size="sm" onClick={reads.reload}>Try again</Button></div>
      </section>
    );
  }
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
function HomeRow({ to, state, face, title, meta, metaFirst = false, line, onClick }: { to: string; state?: unknown; face: ReactNode; title: ReactNode; meta?: ReactNode; metaFirst?: boolean; line?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <li>
      <Link className="home__row" to={to} state={state} onClick={onClick}>
        {face}
        <span className="home__row-b">
          {metaFirst && meta ? <span className="home__row-k">{meta}</span> : null}
          <span className="home__row-t">{title}</span>
          {!metaFirst && meta ? <span className="home__row-k">{meta}</span> : null}
          {line ? <span className="home__row-k home__row-line">{line}</span> : null}
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
    // Each by its one label: two people's agents both called "Assistant" are told apart by whose they are (v0.2.1 release gate).
    const from = nameList(decisions.flatMap((item) => (item.from?.name ? [fromWords(item.from)] : [])));
    return (
      <HomeRow to="/inbox" state={{ select: decisions[0]!.key }} face={<span className="nyc__face nyc__face--icon"><Icon name="flag" size={16} /></span>}
        title={`${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} waiting`}
        meta={[places.slice(0, 2).join(' · '), from ? `from ${from}` : null].filter(Boolean).join(' · ')} />
    );
  }
  const { item } = row;
  const run = item.assistantChanges ?? null;
  // A question in a decision's discussion says which decision it is about, as the Inbox does (#1424, persona round 8).
  const project = item.about ? `about “${item.about.title}”` : item.project?.name ?? null;
  // A run's changes are always the viewer's own agent's; any other agent in the space can ask, so a question or a suggestion names it by its one label,
  // "Reviewer · Ada's agent", as the Inbox does (only an agent whose owner the read does not name says "Agent").
  const meta = (run ? [run.agentName, 'Your agent', project]
    : [kindWord(item), item.from ? fromWords(item.from) : null, bareAgent(item.from) ? 'Agent' : null, project]).filter(Boolean).join(' · ');
  // A blocked task says what it waits for under its title, in the words the board, the List and the Inbox use ("Waiting for Basia Wrona · the
  // new seals", persona round 6): one blocked line everywhere.
  return <HomeRow to="/inbox" state={{ select: item.key }} face={<Face item={item} />} title={item.title} meta={meta} metaFirst
    line={item.kind === 'blocked' && item.detail ? item.detail : undefined} />;
}

type StepRow = { key: FirstStep | 'push' | `joined:${string}`; icon: 'edit' | 'people' | 'spark' | 'chat' | 'person' | 'bell'; title: string; meta: string; to?: string; state?: unknown };

/**
 * What Connect AI offers on this server, in the step's one line (v0.2.1 release gate, O01): a plan only where the server runs it, else an API key or
 * the person's own Claude Code or Codex. The plans come with the first steps (`FirstSteps.plans`), so Home reads nothing more for them.
 */
function connectOffer(offered: AgentRuntimeClient[]): string {
  const plans = [offered.includes('claude_code') ? 'Claude' : null, offered.includes('codex') ? 'ChatGPT' : null].filter(Boolean);
  return plans.length ? `A ${plans.join(' or ')} plan, or an API key` : 'An API key, or Claude Code or Codex on your computer';
}

const STEP_ROWS: Record<FirstStep, (read: FirstStepsRead, spaceName: (id: string | null) => string, offer: string) => StepRow> = {
  name_company: () => ({ key: 'name_company', icon: 'edit', title: 'Name your company', meta: 'Shown on the sign-in page and in emails', to: '/settings/company?name=1' }),
  invite_people: () => ({ key: 'invite_people', icon: 'people', title: 'Invite people', meta: 'Make a link and send it to them', to: '/settings/company?invite=1' }),
  connect_ai: (_read, _space, offer) => ({ key: 'connect_ai', icon: 'spark', title: 'Connect AI', meta: offer, to: '/settings/agents?connect=1' }),
  // Said in the space the person landed in (their link's space, else Everyone), by its name (#1424).
  first_message: (read, spaceName) => ({ key: 'first_message', icon: 'chat', title: 'Write your first message', meta: `Say hello in ${spaceName(read.firstSpaceId)}`, to: `/projects/${read.firstSpaceId}`, state: { focusComposer: true } }),
  photo: () => ({ key: 'photo', icon: 'person', title: 'Add your photo', meta: 'So people know it’s you', to: '/settings/account' }),
};

/**
 * The card's rows, at most three: the steps left, with the people who joined with the person's links ("Nia joined · Say hello", #1424) in the place of
 * "Invite people", which is done once a link was made. The steps come first, so a person who joined never pushes one out.
 */
function firstStepRows(read: FirstStepsRead, spaceName: (id: string | null) => string, offer: string): StepRow[] {
  const steps = read.steps.map((step) => STEP_ROWS[step](read, spaceName, offer));
  const room = Math.max(0, 3 - steps.length);
  const names = (person: FirstStepJoined) => read.joined.filter((other) => firstName(other.name) === firstName(person.name)).length > 1 ? person.name : firstName(person.name);
  // Everyone who joined is told, in one row (personas-26: the third person who joined was dropped; round 14, new P3-g: one batch of five
  // read as two different rows, "Ana joined · Say hello" and "Leo joined · Say hello · Stefan, Kasia and 1 more joined too"). The row names
  // who joined, "Ana, Leo and 3 more joined", and greets the first; once greeted, it greets the next, until everyone was greeted.
  const first = room > 0 ? read.joined[0] : undefined;
  const joined: StepRow[] = first ? [{ key: `joined:${first.userId}`, icon: 'chat', title: `${nameList(read.joined.map(names))} joined`,
    meta: read.joined.length > 1 ? `Say hello to ${names(first)}` : 'Say hello' }] : [];
  const lead = steps.findIndex((row) => row.key !== 'name_company');
  return [...steps.slice(0, lead < 0 ? steps.length : lead), ...joined, ...(lead < 0 ? [] : steps.slice(lead))];
}

/**
 * First steps (founder decisions, Hubert, 2026-11-13, #1438; docs/design/final/README.md "Home"): one card for every new person but a guest
 * (the server decides who is new and still has a step left), at most three rows by role, each gone once done, and one quiet Hide for good. A member's third row turns notifications on for this device
 * where push is available and it is not on yet: the one-time offer then waits (`onPushRow`).
 */
function FirstStepsCard({ phone, workspaceId, userId, onPushRow }: { phone: boolean; workspaceId: string; userId: string; onPushRow: (shown: boolean) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const keys = useRef(attemptKeys());
  const touch = useMediaQuery(MEDIA.touch);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [read, setReadState] = useState<FirstStepsRead | null>(() => lastFirstSteps?.userId === userId ? lastFirstSteps.read : null);
  const setRead = (next: FirstStepsRead | null | ((current: FirstStepsRead | null) => FirstStepsRead | null)) => setReadState((current) => {
    const value = typeof next === 'function' ? next(current) : next;
    lastFirstSteps = value ? { userId, read: value } : null;
    return value;
  });
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getFirstSteps(controller.signal).then(async (next) => {
      setRead(next);
      // Notifications on this device are never a card of their own: only beside a step that is left (the server says so in `offerPush`).
      if (!next.offerPush || !next.steps.length) return;
      const push = await getPushState().catch(() => null);
      if (!controller.signal.aborted && push?.state === 'prompt') setPushKey(push.publicKey);
    }, () => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { projects } = useShellData();
  const spaceName = (id: string | null) => projects.find((project) => project.id === id)?.name ?? 'your space';
  const rows: StepRow[] = read && !hidden ? firstStepRows(read, spaceName, connectOffer(read.plans)) : [];
  if (read && !hidden && pushKey) rows.push({ key: 'push', icon: 'bell', title: `Get notifications on this ${phone ? 'phone' : 'computer'}`, meta: 'When someone writes to you or calls' });
  const shown = rows.slice(0, 3);
  const pushShown = shown.some((row) => row.key === 'push');
  useEffect(() => { onPushRow(pushShown); }, [onPushRow, pushShown]);
  if (!shown.length) return null;
  const hide = () => { setHidden(true); lastFirstSteps = null; void hideFirstSteps().catch(() => undefined); };
  /** "Say hello" opens the direct message with the person who joined (made now if there is none); that is what takes the row away. */
  const sayHello = (userId: string) => {
    if (greeting) return;
    setGreeting(userId);
    // What is typed while the conversation opens is the greeting (P2 #2): kept until its composer takes focus, never a shortcut.
    if (!touch) awaitField();
    openDm(workspaceId, [userId], keys.current.for(userId)).then((dm) => {
      keys.current.done();
      setRead((current) => current && { ...current, joined: current.joined.filter((person) => person.userId !== userId) });
      navigate(`/dm/${dm.id}`);
    }, () => { stopAwaitingField(); setGreeting(null); toast({ message: 'Couldn’t open the conversation. Try again.' }); });
  };
  const turnOn = (publicKey: string) => {
    // Called in the tap itself: the browser asks only after a gesture.
    const pending = enablePushNotifications(publicKey);
    setAsking(true);
    void pending.then((result) => { setAsking(false); if (result.status === 'subscribed' || result.status === 'denied') setPushKey(null); });
  };
  return (
    <section className="home__steps" aria-labelledby="home-steps" data-first-steps="">
      <div className="home__sech">
        <h3 id="home-steps">First steps</h3>
        <Button variant="quiet" size="sm" onClick={hide}>Hide</Button>
      </div>
      <ul className="home__rows" aria-label="First steps">
        {shown.map((row) => row.key === 'push' ? (
          // The same Home row as the others. Its tap asks for notifications in place (the browser asks only in a gesture); without a key to
          // ask with, it opens Settings › Notifications, where the same switch is.
          <HomeRow key={row.key} to="/settings/notifications" face={<span className="nyc__face nyc__face--icon"><Icon name={row.icon} size={16} /></span>}
            title={row.title} meta={row.meta} onClick={(event) => { if (!pushKey) return; event.preventDefault(); if (!asking) turnOn(pushKey); }} />
        ) : row.key.startsWith('joined:') ? (
          <HomeRow key={row.key} to="/dm" face={<span className="nyc__face nyc__face--icon"><Icon name={row.icon} size={16} /></span>} title={row.title} meta={row.meta}
            onClick={(event) => { event.preventDefault(); sayHello(row.key.slice('joined:'.length)); }} />
        ) : (
          <HomeRow key={row.key} to={row.to!} state={row.state} face={<span className="nyc__face nyc__face--icon"><Icon name={row.icon} size={16} /></span>}
            title={row.title} meta={row.meta} />
        ))}
      </ul>
    </section>
  );
}

/** Home (F-026 §7, P1, #865): the date and a greeting, what waits for you (the top of the Inbox), and where to continue. */
export function Home() {
  const moments = useSmallMoments();
  const { me, workspace, removedFrom, workspaces, projects, lockedWorkspaces } = useShellData();
  const { openCreate } = useShellActions();
  const phone = useMediaQuery(MEDIA.navDrawer);
  const queue = useNeedsYou(me.user.id);
  const now = useMemo(() => new Date(), []);
  const firstName = me.user.name.trim().split(/\s+/)[0] || me.user.name;
  const rows = waitingRows(queue.items ?? []);
  // The items the count holds that no row stands for (Home lists the top three rows).
  const beyond = (queue.items?.length ?? 0) - rows.reduce((sum, row) => sum + ('decisions' in row ? row.decisions.length : 1), 0);
  const workspaceIds = useMemo(() => workspaces.map((space) => space.id), [workspaces]);
  const reads = useContinue(me.user.id, workspaceIds);
  // A person with no space yet gets one first step, not an empty queue and links to empty pages (#763 FT-1, S21).
  // A space waiting to be unlocked is not a first run (F-030, #655).
  const firstRun = projects.length === 0 && !lockedWorkspaces.length && !rows.length;
  const joinedSpace = workspace;
  const [pushRow, setPushRow] = useState(false);

  return (
    <div className="pane-scroll"><div className="pane-in home">
      <p className="home__date">{dateFormat.format(now)}</p>
      <h2 className="home__hello">{greeting(now.getHours())}, {firstName}</h2>

      {/* Without a sidebar (phone) Home carries the working agents with Stop; nothing shows while none works (S13). */}
      {phone ? <><WorkingAssistant /><HomeWorkingAgents /></> : null}

      {/* #1438: first steps for every new person but a guest, above what waits (it replaces the new member's empty Home line). */}
      {firstRun || !workspace ? null : <FirstStepsCard phone={phone} workspaceId={workspace.id} userId={me.user.id} onPushRow={setPushRow} />}

      {firstRun ? (
        <section className="home__card home__first" aria-labelledby="home-first">
          {moments ? <Kreska size={56} expression="hello" /> : null}
          {joinedSpace ? <>
            {/* #763 FT-3, F-037: someone in the company with only Everyone is told how other spaces reach them. */}
            <h3 id="home-first">You’re in {joinedSpace.name}</h3>
            {/* A guest does not start spaces, so they are not told they can (#1424). A new space is listed under Spaces, the sidebar's heading
                and the phone's tab alike, not on Home (#1424). */}
            <p>When someone adds you to a space, it appears under Spaces at once.{startsSpaces(joinedSpace) ? ' You can also start your own.' : ''}</p>
            {startsSpaces(joinedSpace) ? <Button variant="secondary" size="lg" onClick={() => openCreate({ kind: 'space' })}>Start a space</Button> : null}
          </> : <>
          {/* F-037: an account nobody has invited yet joins through a link from the company's admin. */}
          {removedFrom ? <>
            {/* A person who was in the company and is not any more (they left or were removed) is told so, and how to come back. */}
            <h3 id="home-first">You’re no longer in {removedFrom}</h3>
            <p>Ask an owner or admin of the company for an invite link to come back.</p>
          </> : <>
            <h3 id="home-first">You’re not in a company here yet</h3>
            <p>Flux is where a company’s people and agents talk, turn what is said into tasks and decisions, and keep what they learn.</p>
            <p className="home__first-note">Got an invite link? Open it to join your company.</p>
          </>}
          </>}
        </section>
      ) : (
        <section className="home__need" aria-labelledby="home-need">
          <div className="home__sech">
            <h3 id="home-need">Waiting for you{queue.count ? <span className="home__n">{queue.count}</span> : null}</h3>
            {/* The same small text button as Hide in the same slot of First steps. What the count holds beyond the rows is named on it, so
                "Waiting for you 4" over three rows adds up (personas-26). */}
            <Link className="ui-btn ui-btn--quiet ui-btn--sm" to="/inbox" aria-keyshortcuts="G I">Open Inbox{beyond > 0 ? ` · ${beyond} more` : ''}</Link>
          </div>
          {/* A read that failed says so, with Try again, as Continue does below; it never keeps saying it is looking (round 14, look-a A6). */}
          {queue.items === null && queue.failed ? <div className="home__card home__quiet" role="alert">This couldn’t be loaded. <Button variant="link" size="sm" onClick={queue.reload}>Try again</Button></div>
            : queue.items === null ? <div className="home__card home__quiet" aria-busy="true">Looking at what waits for you…</div>
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

      {/* Nothing appears twice (#1424 C): Continue offers nothing the Inbox holds, its rows here or the items beyond them. */}
      <ContinueSection reads={reads} covered={queue.items === null && !queue.failed ? null : waitingIds(waitingRows(queue.items ?? [], Infinity))} />
      {/* The one-time offer to turn notifications on (#1243): last on the page, since it may not come (motion rule 6). */}
      {/* Someone removed from the company (or not in one yet) is told nothing here: the offer is not made to them (personas-34). */}
      <PushOffer userId={me.user.id} hidden={pushRow || !workspace} ready={(queue.items ?? []).some((item) => item.kind === 'mention' || item.reason === 'question')} />
    </div></div>
  );
}
