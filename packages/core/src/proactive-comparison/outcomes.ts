import type { BackgroundComputeUsage, InspectedComparisonSource, InsufficientComparisonOutcome,
  Page, ProactiveComparisonOutcome } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';

export type ComparisonSourceRef = Pick<InspectedComparisonSource, 'type' | 'id' | 'version' | 'conversationId' | 'sketchId'>;
export interface ComparisonOutcomePorts {
  access: {
    requireProject(principal: Principal, projectId: string, mode: 'read' | 'write'): Promise<void>;
    canOpenSource(principal: Principal, projectId: string, source: ComparisonSourceRef): Promise<boolean>;
  };
  outcomes: {
    listProject(projectId: string, limit: number, offset: number): Promise<{ items: ProactiveComparisonOutcome[]; total: number }>;
    lockInsufficient(id: string): Promise<InsufficientComparisonOutcome | null>;
    dismissInsufficient(id: string, expectedVersion: number): Promise<InsufficientComparisonOutcome | null>;
    ownerUsage(ownerId: string, now: Date): Promise<BackgroundComputeUsage>;
  };
}
export interface ComparisonOutcomeUnitOfWork {
  run<T>(action: (ports: ComparisonOutcomePorts) => Promise<T>): Promise<T>;
}

const uuid = (value: string) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function visibleOutcome(ports: ComparisonOutcomePorts, principal: Principal, projectId: string,
  outcome: ProactiveComparisonOutcome): Promise<ProactiveComparisonOutcome> {
  const visible: InspectedComparisonSource[] = [];
  let unavailableSourcesCount = 0;
  for (const source of outcome.inspectedSources ?? []) {
    if (await ports.access.canOpenSource(principal, projectId, source)) visible.push(source);
    else unavailableSourcesCount++;
  }
  if (outcome.kind === 'insufficient_evidence') return { ...outcome, inspectedSources: visible, unavailableSourcesCount };
  // Cited references need the same current check; their old titles must not bypass it.
  const sources: typeof outcome.proposal.sources = [];
  for (const source of outcome.proposal.sources) {
    if (await ports.access.canOpenSource(principal, projectId, source)) sources.push(source);
  }
  return { ...outcome, proposal: { ...outcome.proposal, sources },
    inspectedSources: outcome.inspectedSources === null ? null : visible, unavailableSourcesCount };
}

export function comparisonOutcomeUseCases(unit: ComparisonOutcomeUnitOfWork) {
  return {
    list(principal: Principal, projectId: string, limit = 50, offset = 0): Promise<Page<ProactiveComparisonOutcome>> {
      if (!uuid(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
        throw new InvalidInputError('A page limit of 1–100 and an offset of 0–10000 are required');
      return unit.run(async (ports) => {
        await ports.access.requireProject(principal, projectId, 'read');
        const page = await ports.outcomes.listProject(projectId, limit, offset);
        const items: ProactiveComparisonOutcome[] = [];
        for (const outcome of page.items) items.push(await visibleOutcome(ports, principal, projectId, outcome));
        return { items, total: page.total, limit, offset };
      });
    },
    dismiss(principal: Principal, id: string, expectedVersion: number): Promise<InsufficientComparisonOutcome> {
      if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person must review the outcome');
      if (!uuid(id)) throw new NotFoundError('Outcome');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new InvalidInputError('An expected version is required');
      return unit.run(async (ports) => {
        const current = await ports.outcomes.lockInsufficient(id);
        if (!current) throw new NotFoundError('Outcome');
        await ports.access.requireProject(principal, current.projectId, 'write');
        if (current.version !== expectedVersion) throw new VersionConflictError(current.version, { version: current.version });
        if (current.status !== 'open') throw new ConflictError('The outcome has already been dismissed', 'OUTCOME_REVIEWED');
        const changed = await ports.outcomes.dismissInsufficient(id, expectedVersion);
        if (!changed) throw new VersionConflictError(current.version, { version: current.version });
        return await visibleOutcome(ports, principal, current.projectId, changed) as InsufficientComparisonOutcome;
      });
    },
    usage(principal: Principal, now = new Date()): Promise<BackgroundComputeUsage> {
      if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in owner is required');
      return unit.run((ports) => ports.outcomes.ownerUsage(principal.id, now));
    },
  };
}
