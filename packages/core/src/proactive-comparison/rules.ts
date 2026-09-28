import { randomUUID } from 'node:crypto';
import type { CreateProactiveComparisonRule, ProactiveComparisonRule } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';

export interface RuleAccess {
  requireProject(principal: Principal, projectId: string, action: 'read' | 'write'): Promise<{ workspaceId: string }>;
}
export interface RuleRows {
  /** The agent is personal to the caller and currently has a contributor grant here. */
  agentMayPropose(ownerId: string, projectId: string, agentId: string): Promise<boolean>;
  create(input: { id: string; workspaceId: string; projectId: string; ownerUserId: string; command: CreateProactiveComparisonRule }): Promise<ProactiveComparisonRule | 'EXISTS'>;
  list(ownerId: string, projectId: string): Promise<ProactiveComparisonRule[]>;
  find(ownerId: string, ruleId: string): Promise<ProactiveComparisonRule | null>;
  change(ownerId: string, ruleId: string, expectedVersion: number, status: 'enabled' | 'paused' | 'revoked'): Promise<ProactiveComparisonRule | null>;
}
export interface RuleUnitOfWork {
  run<T>(action: (ports: { access: RuleAccess; rules: RuleRows }) => Promise<T>): Promise<T>;
}

function owner(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}
function uuid(id: string): boolean { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }
function bounded(n: number, lo: number, hi: number): boolean { return Number.isInteger(n) && n >= lo && n <= hi; }

export function proactiveRuleUseCases(unit: RuleUnitOfWork) {
  return {
    async create(principal: Principal, projectId: string, command: CreateProactiveComparisonRule): Promise<ProactiveComparisonRule> {
      const ownerUserId = owner(principal);
      if (!uuid(projectId) || !command || !uuid(command.agentId)
        || command.trigger !== 'human_negative_result' || command.purpose !== 'camera_sensor_comparison'
        || command.dataScope !== 'current_project_published' || command.permittedEffect !== 'quiet_project_proposal'
        || !bounded(command.maxRunsPerDay, 1, 3) || !bounded(command.periodBudgetCents, 5, 500)
        || !bounded(command.perRunCents, 5, 50) || command.perRunCents > command.periodBudgetCents)
        throw new InvalidInputError('A scoped comparison rule with bounded run and period limits is required');
      return unit.run(async ({ access, rules }) => {
        const { workspaceId } = await access.requireProject(principal, projectId, 'write');
        if (!await rules.agentMayPropose(ownerUserId, projectId, command.agentId))
          throw new NotFoundError('Personal project agent', 'AGENT_NOT_FOUND');
        const result = await rules.create({ id: randomUUID(), workspaceId, projectId, ownerUserId, command });
        if (result === 'EXISTS') throw new ConflictError('A comparison rule already exists for this project', 'RULE_EXISTS');
        return result;
      });
    },
    async list(principal: Principal, projectId: string): Promise<ProactiveComparisonRule[]> {
      const ownerUserId = owner(principal);
      if (!uuid(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      return unit.run(async ({ access, rules }) => {
        await access.requireProject(principal, projectId, 'read');
        return rules.list(ownerUserId, projectId);
      });
    },
    async setStatus(principal: Principal, ruleId: string, expectedVersion: number, status: 'enabled' | 'paused' | 'revoked'): Promise<ProactiveComparisonRule> {
      const ownerUserId = owner(principal);
      if (!uuid(ruleId)) throw new NotFoundError('Rule', 'RULE_NOT_FOUND');
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || !['enabled', 'paused', 'revoked'].includes(status))
        throw new InvalidInputError('Expected version and valid status are required');
      return unit.run(async ({ access, rules }) => {
        const current = await rules.find(ownerUserId, ruleId);
        if (!current) throw new NotFoundError('Rule', 'RULE_NOT_FOUND');
        await access.requireProject(principal, current.projectId, 'write');
        if (current.version !== expectedVersion) throw new VersionConflictError(current.version, current);
        if (current.status === 'revoked') throw new ConflictError('A revoked rule cannot be enabled again', 'RULE_REVOKED');
        if (status === 'enabled') {
          if (!await rules.agentMayPropose(ownerUserId, current.projectId, current.agentId))
            throw new NotFoundError('Personal project agent', 'AGENT_NOT_FOUND');
          // O-007 requires owner-supplied background compute and payer consent before
          // a rule can run. This first slice stores a paused rule; key custody and
          // execution are separate slices, so activation fails closed for now.
          throw new ConflictError('Connect an authorized background compute source before enabling', 'BACKGROUND_CONNECTION_REQUIRED');
        }
        return (await rules.change(ownerUserId, ruleId, expectedVersion, status))!;
      });
    },
  };
}
