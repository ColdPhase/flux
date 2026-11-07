import type { SetTaskTaking, TaskTaking } from '@flux/contracts';
import { ConflictError, InvalidInputError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { isId } from '../work/validation.js';

// "When someone assigns a task to me: Do nothing / Give it to [agent]" (#856, F-036 AG-5). One setting per person, naming
// exactly one of their own agents that run on the server. There is no rule per space and no automatic choice: to give one task
// to another agent, its owner changes the Owner field.

export interface TaskTakingPorts {
  /** The person's own agents that run on the server, oldest first. */
  agents(userId: string): Promise<{ id: string; name: string }[]>;
  taking(userId: string): Promise<string | null>;
  setTaking(userId: string, agentId: string | null): Promise<void>;
}
export interface TaskTakingUnitOfWork { run<T>(work: (ports: TaskTakingPorts) => Promise<T>): Promise<T> }

function person(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

export function createTaskTaking(uow: TaskTakingUnitOfWork) {
  async function read(ports: TaskTakingPorts, userId: string): Promise<TaskTaking> {
    const agents = await ports.agents(userId);
    const chosen = await ports.taking(userId);
    // An agent that was removed since is "Do nothing" again, never a stale name.
    return { agents, takes: chosen && agents.some((agent) => agent.id === chosen) ? chosen : null };
  }
  return {
    get: (principal: Principal) => { const userId = person(principal); return uow.run((ports) => read(ports, userId)); },
    set(principal: Principal, command: SetTaskTaking): Promise<TaskTaking> {
      const userId = person(principal);
      if (!command || typeof command !== 'object' || (command.agentId !== null && !isId(command.agentId))) throw new InvalidInputError('Choose one of your agents, or Do nothing');
      return uow.run(async (ports) => {
        if (command.agentId !== null && !(await ports.agents(userId)).some((agent) => agent.id === command.agentId!.toLowerCase()))
          throw new ConflictError('That is not one of your agents', 'TASK_TAKING_NOT_YOUR_AGENT');
        await ports.setTaking(userId, command.agentId === null ? null : command.agentId.toLowerCase());
        return read(ports, userId);
      });
    },
  };
}
