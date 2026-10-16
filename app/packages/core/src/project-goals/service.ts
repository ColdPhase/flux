import { randomUUID } from 'node:crypto';
import { PROJECT_GOAL_MAX, type ProjectGoal, type ProjectGoalEvent, type ProjectGoalList, type ProjectGoalState, type SetProjectGoalCommand } from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError, PreconditionRequiredError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { ProjectGoalPorts, ProjectGoalRecord, ProjectGoalUnitOfWork } from './ports.js';

// A project's optional goal (#520, F-028, docs/product/project-goals.md). Each change runs in one unit
// of work: it locks the project, asks the access port (`project.write`), requires a signed-in person,
// checks the project version the caller saw (If-Match), changes the goal, moves the project's version on
// and records one project event, so all of it commits together. A goal is reached only when a person
// says so: nothing here reads tasks, PRs, results or messages. Events never create notifications.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many goals the history read returns (newest first). */
const LIST_LIMIT = 50;

const person = (id: string, name: string | null) => ({ id, name: name ?? 'Former member' });

export function presentProjectGoal(record: ProjectGoalRecord): ProjectGoal {
  return {
    id: record.id, projectId: record.projectId, title: record.title,
    setBy: person(record.setBy, record.setByName), setAt: record.setAt.toISOString(),
    reachedAt: record.reachedAt?.toISOString() ?? null,
    reachedBy: record.reachedBy ? person(record.reachedBy, record.reachedByName) : null,
  };
}

/** One sentence on one line: runs of spaces and line breaks become one space, then 1–120 characters. */
export function projectGoalTitle(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidInputError('A goal is one sentence of text', 'GOAL_INVALID');
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title || [...title].length > PROJECT_GOAL_MAX) throw new InvalidInputError(`A goal is 1–${PROJECT_GOAL_MAX} characters`, 'GOAL_INVALID');
  return title;
}

function expectedVersion(value: unknown): number {
  if (value === undefined || value === null) throw new PreconditionRequiredError();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
  return value;
}

async function shown(ports: ProjectGoalPorts, projectId: string): Promise<ProjectGoal | null> {
  const goal = await ports.goals.current(projectId) ?? await ports.goals.latestReached(projectId);
  return goal ? presentProjectGoal(goal) : null;
}

export function createProjectGoalUseCases(unit: ProjectGoalUnitOfWork) {
  /**
   * The shared frame of every change. Authorization comes before the person rule and the version, so an
   * invisible project stays a 404 and a stale version never reveals anything the caller may not read.
   */
  function change(principal: Principal, projectId: string, expected: unknown,
    work: (ports: ProjectGoalPorts, workspaceId: string, by: string) => Promise<{ kind: ProjectGoalEvent; goalId: string } | null>): Promise<ProjectGoalState> {
    return unit.run(async (ports) => {
      if (!UUID.test(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      await ports.goals.lockProject(projectId);
      const { workspaceId } = await ports.access.write(principal, projectId);
      if (principal.kind !== 'human' || !principal.id) throw new ForbiddenError('Only a person can change a project goal; agents can read it', 'GOAL_NEEDS_PERSON');
      const version = expectedVersion(expected);
      const current = await ports.goals.projectVersion(projectId);
      if (current !== version) throw new VersionConflictError(current, { projectId, version: current, goal: await shown(ports, projectId) } satisfies ProjectGoalState);
      const changed = await work(ports, workspaceId, principal.id);
      if (!changed) return { projectId, version: current, goal: await shown(ports, projectId) };
      const next = await ports.goals.bumpProject(projectId);
      await ports.events.record(principal, workspaceId, changed.kind, projectId, { goalId: changed.goalId });
      return { projectId, version: next, goal: await shown(ports, projectId) };
    });
  }

  return {
    /** Sets the current goal (a new id), or edits the current goal's title (same id). Equal words change nothing. */
    set(principal: Principal, projectId: string, command: SetProjectGoalCommand, expected: unknown): Promise<ProjectGoalState> {
      const title = projectGoalTitle(command?.title);
      return change(principal, projectId, expected, async (ports, workspaceId, by) => {
        const current = await ports.goals.current(projectId);
        if (current?.title === title) return null;
        const goal = current ? await ports.goals.updateTitle(current.id, title) : await ports.goals.insert({ id: randomUUID(), workspaceId, projectId, title, setBy: by });
        return { kind: 'project.goal_set.v1', goalId: goal.id };
      });
    },

    /** Removes the current goal before it is reached; nothing was celebrated, so nothing is kept. */
    remove(principal: Principal, projectId: string, expected: unknown): Promise<ProjectGoalState> {
      return change(principal, projectId, expected, async (ports) => {
        const current = await ports.goals.current(projectId);
        if (!current) throw new RuleViolationError('This project has no current goal', 'NO_CURRENT_GOAL');
        await ports.goals.remove(current.id);
        return { kind: 'project.goal_removed.v1', goalId: current.id };
      });
    },

    /** A person says the current goal is reached. The project itself is unchanged and goes on. */
    reach(principal: Principal, projectId: string, expected: unknown): Promise<ProjectGoalState> {
      return change(principal, projectId, expected, async (ports, _workspaceId, by) => {
        const current = await ports.goals.current(projectId);
        if (!current) throw new RuleViolationError('This project has no current goal', 'NO_CURRENT_GOAL');
        await ports.goals.markReached(current.id, by);
        return { kind: 'project.goal_reached.v1', goalId: current.id };
      });
    },

    /** Undo of "reached": the latest reached goal becomes current again, only while no other goal is current. */
    reopen(principal: Principal, projectId: string, expected: unknown): Promise<ProjectGoalState> {
      return change(principal, projectId, expected, async (ports) => {
        if (await ports.goals.current(projectId)) throw new RuleViolationError('Another goal is current; remove it before reopening this one', 'GOAL_CURRENT');
        const latest = await ports.goals.latestReached(projectId);
        if (!latest) throw new RuleViolationError('This project has no reached goal', 'NO_REACHED_GOAL');
        await ports.goals.reopen(latest.id);
        return { kind: 'project.goal_reopened.v1', goalId: latest.id };
      });
    },

    /** The current goal and the reached ones, newest first, for everyone who can read the project. */
    list(principal: Principal, projectId: string): Promise<ProjectGoalList> {
      return unit.run(async (ports) => {
        if (!UUID.test(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
        await ports.access.read(principal, projectId);
        return { items: (await ports.goals.list(projectId, LIST_LIMIT)).map(presentProjectGoal) };
      });
    },
  };
}

export type ProjectGoalUseCases = ReturnType<typeof createProjectGoalUseCases>;
