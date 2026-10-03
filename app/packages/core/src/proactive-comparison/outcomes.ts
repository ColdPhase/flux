import type { BackgroundComputeUsage, InspectedComparisonSource, InsufficientComparisonOutcome,
  Page, ProactiveComparisonOutcome, ProactiveComparisonProposal } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
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
    /** Metadata of the exact pair; called only after successful current project-read policy. */
    usageContext(projectId: string, resultId: string): Promise<{ projectTitle: string; resultTitle: string } | null>;
  };
}
export interface ComparisonOutcomeUnitOfWork {
  run<T>(action: (ports: ComparisonOutcomePorts) => Promise<T>): Promise<T>;
}

const uuid = (value: string) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * A proposal as its current reader may see it. Stored citations keep their history, but one this
 * reader cannot open now (deleted, moved or without access) loses its id and title. Every response
 * that carries a proposal, reads and changes alike, passes through here: a stored title must not
 * bypass the check that the read paths apply.
 */
export async function visibleProposal(access: ComparisonOutcomePorts['access'], principal: Principal,
  proposal: ProactiveComparisonProposal): Promise<ProactiveComparisonProposal> {
  const sources: ProactiveComparisonProposal['sources'] = [];
  for (const source of proposal.sources) {
    if (await access.canOpenSource(principal, proposal.projectId, source)) sources.push(source);
  }
  return { ...proposal, sources };
}

async function visibleOutcome(ports: ComparisonOutcomePorts, principal: Principal, projectId: string,
  outcome: ProactiveComparisonOutcome): Promise<ProactiveComparisonOutcome> {
  const visible: InspectedComparisonSource[] = [];
  let unavailableSourcesCount = 0;
  for (const source of outcome.inspectedSources ?? []) {
    if (await ports.access.canOpenSource(principal, projectId, source)) visible.push(source);
    else unavailableSourcesCount++;
  }
  if (outcome.kind === 'insufficient_evidence') return { ...outcome, inspectedSources: visible, unavailableSourcesCount };
  return { ...outcome, proposal: await visibleProposal(ports.access, principal, outcome.proposal),
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
      return unit.run(async (ports) => {
        const usage = await ports.outcomes.ownerUsage(principal.id, now);
        const allowed = new Set<string>();
        for (const projectId of [...new Set(usage.candidates.map((row) => row.projectId))].sort()) {
          try {
            await ports.access.requireProject(principal, projectId, 'read');
            allowed.add(projectId);
          } catch (error) {
            if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
          }
        }
        const contexts = new Map<string, { projectTitle: string; resultTitle: string } | null>();
        const candidates: BackgroundComputeUsage['candidates'] = [];
        for (const row of usage.candidates) {
          const pair = `${row.projectId}:${row.resultId}`;
          if (!contexts.has(pair)) {
            const found = allowed.has(row.projectId) ? await ports.outcomes.usageContext(row.projectId, row.resultId) : null;
            contexts.set(pair, found ? { projectTitle: found.projectTitle, resultTitle: found.resultTitle } : null);
          }
          candidates.push({ ...row, context: contexts.get(pair)! });
        }
        return { ...usage, candidates };
      });
    },
  };
}
