import { randomUUID } from 'node:crypto';
import type { AiPrice, CreateProactiveComparisonRule, ProactiveComparisonRule } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { comparisonReservationCents } from './reservation.js';

export interface RuleAccess {
  requireProject(principal: Principal, projectId: string, action: 'read' | 'write'): Promise<{ workspaceId: string }>;
}
export interface RuleRows {
  /** The agent is personal to the caller and currently has a contributor grant here. */
  agentMayPropose(ownerId: string, projectId: string, agentId: string): Promise<boolean>;
  backgroundBudget(ownerId: string): Promise<{ maxRunsPerDay: number; periodDays: number; periodBudgetCents: number; perRunCents: number;
    price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null } | null>;
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

/**
 * `runtimeAvailable` is true only when the operator switched background comparisons on
 * (`backgroundComparisonsEnabled`), so a worker with reservation, interruption and current-access
 * checks runs them; otherwise enabling fails closed with BACKGROUND_RUNTIME_UNAVAILABLE.
 */
export function proactiveRuleUseCases(unit: RuleUnitOfWork, { runtimeAvailable = false }: { runtimeAvailable?: boolean } = {}) {
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
          const budget = await rules.backgroundBudget(ownerUserId);
          if (!budget) throw new ConflictError('Connect an authorized background compute source before enabling', 'BACKGROUND_CONNECTION_REQUIRED');
          // PROV-3: without a known price nothing can be reserved, so the connection cannot be enabled.
          if (!budget.price) throw new ConflictError('The connection has no known price', 'BACKGROUND_PRICE_UNKNOWN');
          if (budget.periodDays !== 30 || current.maxRunsPerDay > budget.maxRunsPerDay
            || current.periodBudgetCents > budget.periodBudgetCents || current.perRunCents > budget.perRunCents
            || comparisonReservationCents(budget.price) > Math.min(current.perRunCents, budget.perRunCents))
            throw new ConflictError('The rule exceeds the owner-approved background budget', 'BACKGROUND_BUDGET_TOO_LOW');
          // Key custody and consent are necessary, but a worker with reservation,
          // interruption and current-access checks must run before activation (#58).
          if (!runtimeAvailable) throw new ConflictError('Background execution is not available yet', 'BACKGROUND_RUNTIME_UNAVAILABLE');
        }
        return (await rules.change(ownerUserId, ruleId, expectedVersion, status))!;
      });
    },
  };
}
