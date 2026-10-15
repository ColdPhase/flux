import type { AgentStop, AgentStops, OwnWorkingAgents, StopAgentCommand } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../types.js';

/**
 * Stopping an external agent's work on a task (F-026 S13, #347; docs/product/mcp-cowork.md "Stop and questions").
 * A person who may write in the project and is a manager, the agent's owner or the task's creator ends the hold:
 * the task goes back to nobody, the agent's unfinished co-work units are stopped, and the stop is recorded.
 * Flux cannot kill the local client; it ends what Flux itself granted, and the agent's next call is told.
 */
export interface HeldTask {
  id: string;
  number: number;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'not_pursued';
  version: number;
  ownerAgentId: string | null;
  parked: boolean;
  createdByKind: 'human' | 'agent';
  createdById: string;
}
export interface StoppedAgent {
  id: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  agent: { id: string; name: string };
  stoppedBy: { id: string; name: string };
  stoppedAt: Date;
  unitsStopped: number;
}

export interface AgentStopPorts {
  /** Throws the access policy's 404/403 unless the principal may perform `action` on the project now. */
  requireProject(principal: Principal, projectId: string, action: 'project.read' | 'project.write'): Promise<{ workspaceId: string }>;
  isManager(principal: Principal, projectId: string): Promise<boolean>;
  canRead(principal: Principal, projectId: string): Promise<boolean>;
  /** The canonical task update that clears the owner (and leaves `in_progress`), with its events and history. */
  releaseTask(principal: Principal, task: HeldTask): Promise<void>;
  rows: {
    agent(workspaceId: string, agentId: string): Promise<{ id: string; name: string; ownerUserId: string | null } | null>;
    /** Locks the agent's co-work connection slots; called before the task is locked, as claims do. */
    lockSlots(workspaceId: string, agentId: string): Promise<void>;
    task(projectId: string, taskId: string): Promise<HeldTask | null>;
    stopUnits(workspaceId: string, projectId: string, taskId: string, agentId: string): Promise<number>;
    insert(row: { workspaceId: string; projectId: string; taskId: string; agentId: string; stoppedBy: string; unitsStopped: number }): Promise<string>;
    get(id: string): Promise<StoppedAgent | null>;
    list(scope: { projectId: string }, limit: number): Promise<StoppedAgent[]>;
    /** In-progress, unparked tasks held by agents this person owns, most recently changed first. */
    ownedWorking(userId: string, limit: number): Promise<OwnWorkingAgents['items'][number][]>;
  };
  events: { record(principal: Principal, workspaceId: string, kind: string, projectId: string, data: Record<string, unknown>): Promise<void> };
}

/** One transaction per use case. */
export interface AgentStopUnitOfWork {
  run<T>(work: (ports: AgentStopPorts) => Promise<T>): Promise<T>;
}

const RECENT_STOPS = 20;
const OWN_WORKING = 20;

export function agentStopView(row: StoppedAgent): AgentStop {
  return { id: row.id, taskId: row.taskId, taskNumber: row.taskNumber, taskTitle: row.taskTitle, agent: row.agent,
    stoppedBy: row.stoppedBy, stoppedAt: row.stoppedAt.toISOString(), unitsStopped: row.unitsStopped };
}

function id(value: unknown, what: string, code: string): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new NotFoundError(what, code);
  return value.toLowerCase();
}

export function agentStopUseCases(uow: AgentStopUnitOfWork) {
  return {
    /** The person's own agents working now, in projects they can still read. */
    working: (principal: Principal): Promise<OwnWorkingAgents> => uow.run(async (ports) => {
      if (principal.kind !== 'human') throw new ForbiddenError('A signed-in person is required', 'STOP_NEEDS_PERSON');
      const items = [];
      for (const item of await ports.rows.ownedWorking(principal.id, OWN_WORKING)) {
        if (await ports.canRead(principal, item.task.projectId)) items.push(item);
      }
      return { items };
    }),

    /** Project readers see who stopped what; the newest stops first. */
    list: (principal: Principal, requestedProject: string): Promise<AgentStops> => uow.run(async (ports) => {
      const projectId = id(requestedProject, 'Project', 'PROJECT_NOT_FOUND');
      await ports.requireProject(principal, projectId, 'project.read');
      return { projectId, stops: (await ports.rows.list({ projectId }, RECENT_STOPS)).map(agentStopView) };
    }),

    stop: (principal: Principal, requestedProject: string, command: StopAgentCommand): Promise<AgentStop> => uow.run(async (ports) => {
      const projectId = id(requestedProject, 'Project', 'PROJECT_NOT_FOUND');
      if (principal.kind !== 'human') throw new ForbiddenError('Only a person can stop an agent', 'STOP_NEEDS_PERSON');
      const taskId = id(command?.taskId, 'Work item', 'WORK_NOT_FOUND');
      const agentId = id(command?.agentId, 'Agent', 'AGENT_NOT_FOUND');
      const { workspaceId } = await ports.requireProject(principal, projectId, 'project.write');
      const agent = await ports.rows.agent(workspaceId, agentId);
      if (!agent) throw new NotFoundError('Agent', 'AGENT_NOT_FOUND');
      // Slots first, then the task, as claims lock them: a stop and a claim never wait on each other.
      await ports.rows.lockSlots(workspaceId, agentId);
      const task = await ports.rows.task(projectId, taskId);
      if (!task) throw new NotFoundError('Work item', 'WORK_NOT_FOUND');
      const allowed = agent.ownerUserId === principal.id || (task.createdByKind === 'human' && task.createdById === principal.id)
        || await ports.isManager(principal, projectId);
      if (!allowed) throw new ForbiddenError('Only a project manager, the agent\'s owner or the task\'s creator can stop it', 'STOP_NOT_ALLOWED');
      if (task.ownerAgentId !== agentId || task.parked || task.status === 'done' || task.status === 'not_pursued')
        throw new ConflictError('That agent is not working on this task now', 'AGENT_NOT_WORKING');
      await ports.releaseTask(principal, task);
      const unitsStopped = await ports.rows.stopUnits(workspaceId, projectId, taskId, agentId);
      const stopId = await ports.rows.insert({ workspaceId, projectId, taskId, agentId, stoppedBy: principal.id, unitsStopped });
      await ports.events.record(principal, workspaceId, 'project.agent_stopped.v1', projectId, { stopId, taskId, agentId });
      const stored = await ports.rows.get(stopId);
      if (!stored) throw new InvalidInputError('The stop was not stored');
      return agentStopView(stored);
    }),
  };
}
