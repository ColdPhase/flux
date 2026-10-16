import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { PROJECT_GOAL_MAX, type Project, type ProjectGoal, type ProjectGoalState } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, GoalReached, Icon, goalMomentSeen, markGoalMomentSeen, useToast } from '../ui';
import { MoreMenu, type MoreItem } from '../app/HeaderParts';
import { clock, day, when } from '../app/messageParts';
import { reachProjectGoal, recentlyReached, removeProjectGoal, reopenProjectGoal, setProjectGoal, wrapUpDraft } from './goal';

// A project's optional goal in the web app (#520, F-028): one quiet line in Details with its "⋯"
// actions, and the reached moment in the conversation. A project without a goal shows nothing here
// (Spokój rule 4); people who can write find "Set a goal" in the same "⋯". Nothing is ever inferred.

const who = (person: { id: string; name: string }, meId: string) => person.id === meId ? 'you' : person.name;

/**
 * The goal as this view knows it: the shell's project, or the answer of a change made here until the
 * shell's own read catches up (its version is at least the answer's).
 */
function useGoalState(project: Project) {
  const [local, setLocal] = useState<ProjectGoalState | null>(null);
  const fresh = local && local.projectId === project.id && local.version > project.version ? local : null;
  return { goal: fresh ? fresh.goal : project.goal, version: fresh ? fresh.version : project.version, setLocal };
}

/**
 * Details' goal parts: the "⋯" beside the project name (writers only, always in the same place) and the
 * goal line under the name and people. Who set it or marked it reached, and when, is part of the line.
 */
export function useProjectGoalDetails(project: Project, meId: string): { menu: ReactNode; line: ReactNode } {
  const revalidator = useRevalidator();
  const toast = useToast();
  const { goal, version, setLocal } = useGoalState(project);
  const latest = useRef({ version, goal });
  useEffect(() => { latest.current = { version, goal }; });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const writable = project.access !== 'viewer';
  const reached = !!goal?.reachedAt;

  async function run(action: (version: number) => Promise<ProjectGoalState>): Promise<ProjectGoalState | null> {
    setBusy(true); setError('');
    try {
      const state = await action(latest.current.version);
      setLocal(state);
      latest.current = { version: state.version, goal: state.goal };
      revalidator.revalidate();
      return state;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const current = (cause.body as { current?: ProjectGoalState } | null)?.current;
        if (current?.projectId === project.id) setLocal(current);
        setError('Someone changed the goal meanwhile. Check it, then try again.');
      } else setError('The goal couldn’t be saved. Try again in a moment.');
      revalidator.revalidate();
      return null;
    } finally { setBusy(false); }
  }

  const startEdit = (text: string) => { setValue(text); setError(''); setEditing(true); };
  async function save(event: FormEvent) {
    event.preventDefault();
    const title = value.replace(/\s+/g, ' ').trim();
    if (!title) { setError('Write the goal in one sentence.'); return; }
    if (await run((at) => setProjectGoal(project.id, title, at))) setEditing(false);
  }
  async function markReached() {
    if (!await run((at) => reachProjectGoal(project.id, at))) return;
    toast({ message: 'Goal marked reached', action: { label: 'Undo', onClick: () => void run((at) => reopenProjectGoal(project.id, at)) } });
  }
  async function remove() {
    const title = latest.current.goal?.title;
    if (!await run((at) => removeProjectGoal(project.id, at)) || !title) return;
    toast({ message: 'Goal removed', action: { label: 'Undo', onClick: () => void run((at) => setProjectGoal(project.id, title, at)) } });
  }

  const items: MoreItem[] = !goal || reached
    ? [{ label: reached ? 'Set a new goal' : 'Set a goal', run: () => startEdit('') }, ...(reached ? [{ label: 'Undo goal reached', run: () => void run((at) => reopenProjectGoal(project.id, at)) }] : [])]
    : [{ label: 'Edit goal', run: () => startEdit(goal.title) }, { label: 'Mark goal reached', run: () => void markReached() }, { label: 'Remove goal', run: () => void remove() }];
  const menu = writable ? <MoreMenu items={items} label="Goal actions" /> : null;

  let line: ReactNode = null;
  if (editing) {
    line = (
      <form className="ov-goal ov-goal--edit" onSubmit={(event) => void save(event)} aria-label="Project goal">
        <label className="ov-goal__label" htmlFor={inputId}>{reached || !goal ? 'New goal' : 'Goal'}</label>
        <input id={inputId} className="ui-input" value={value} maxLength={PROJECT_GOAL_MAX} autoFocus autoComplete="off"
          placeholder="One sentence, like “Two shared cargo bikes by spring”" aria-invalid={error ? true : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); setError(''); } }} />
        <div className="ov-goal__actions">
          <Button variant="primary" type="submit" busy={busy}>Save goal</Button>
          <Button variant="quiet" onClick={() => { setEditing(false); setError(''); }}>Cancel</Button>
        </div>
        {error ? <p className="ov-goal__error" role="alert">{error}</p> : null}
      </form>
    );
  } else if (goal) {
    const by = reached && goal.reachedBy ? `${who(goal.reachedBy, meId)} · ${day(goal.reachedAt!)}` : `Set by ${who(goal.setBy, meId)} · ${day(goal.setAt)}`;
    line = (
      <section className="ov-goal" aria-label={reached ? 'Goal reached' : 'Project goal'} data-goal-state={reached ? 'reached' : 'current'}>
        <Icon name={reached ? 'check' : 'goal'} size={16} className="ov-row__ic" />
        <span className="ov-row__b">
          <span className="ov-row__k">{reached ? 'Goal reached' : 'Goal'}</span>
          <span className="ov-row__t ov-goal__t">{goal.title}</span>
          <span className="ov-row__s"><time dateTime={reached ? goal.reachedAt! : goal.setAt} title={when(reached ? goal.reachedAt! : goal.setAt)}>{by}</time></span>
        </span>
        {error ? <p className="ov-goal__error" role="alert">{error}</p> : null}
      </section>
    );
  } else if (error) {
    line = <p className="ov-goal__error" role="alert">{error}</p>;
  }
  return { menu, line };
}

/**
 * A reached goal in the conversation (#520, Prostota `phone-goal`), at the moment it was reached. The first
 * time this device sees a goal reached in the last week, it is the card: Kreska celebrating (when small moments
 * are on), the goal, "<project> · goal reached", Write a wrap-up and Keep going. It counts as seen once it is
 * actually on screen; afterwards, on this device, it is one quiet history line. It never covers anything.
 */
export function GoalStreamEntry({ goal, project, meId }: { goal: ProjectGoal; project: Project; meId: string }) {
  const navigate = useNavigate();
  const [card, setCard] = useState(() => recentlyReached(goal) && !goalMomentSeen(goal.id));
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!card || !node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && document.visibilityState === 'visible') { markGoalMomentSeen(goal.id); observer.disconnect(); }
    }, { threshold: 0.5 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [card, goal.id]);
  const keepGoing = () => { markGoalMomentSeen(goal.id); setCard(false); };
  const wrapUp = () => { markGoalMomentSeen(goal.id); navigate(wrapUpDraft(meId, project.id, goal.title)); };
  const reachedAt = goal.reachedAt!;
  return (
    <li ref={ref} className={`convo-goal${card ? ' convo-goal--card' : ''}`} id={`goal-${goal.id}`} data-goal-id={goal.id}>
      {card ? (
        <GoalReached title={goal.title} project={project.name} actions={<>
          {project.access !== 'viewer' ? <Button variant="primary" onClick={wrapUp}>Write a wrap-up</Button> : null}
          <Button onClick={keepGoing}>Keep going</Button>
        </>} />
      ) : (
        <p className="convo-goal__line">
          <Icon name="check" size={14} />
          <span><b>Goal reached</b> · <span className="convo-goal__title">{goal.title}</span>{goal.reachedBy ? <> · {who(goal.reachedBy, meId)}</> : null}</span>
          <time dateTime={reachedAt} title={when(reachedAt)}>{clock(reachedAt)}</time>
        </p>
      )}
    </li>
  );
}
