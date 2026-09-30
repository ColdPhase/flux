import type { AssistantProposal, DecideAssistantProposalCommand, Page, PageQuery } from '@flux/contracts';
import { ConflictError, ForbiddenError, NotFoundError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { expectedVersion, isId, page } from '../work/validation.js';
import type { PersonalRunPorts, ProposalPorts, ProposalRecord, ProposalUnitOfWork } from './ports.js';
import { assistantLabel, ownerOf } from './service.js';

// Assistant proposals (#68 AC-7, design principle 4). A personal run never saves a
// consequential change: it drafts a proposal visible to the project's audience. Accept and
// dismiss need a person with authority over the target — project write access, and for a result
// that finishes an owned work item, that item's owner or a project manager. The assistant's owner
// gets no extra right from having drafted it. Accept records the result through the #101 work
// use case as the accepting person, in the same transaction, and the proposal keeps the link.

const iso = (date: Date) => date.toISOString();
const notFound = () => new NotFoundError('Assistant proposal', 'ASSISTANT_PROPOSAL_NOT_FOUND');

async function proposalView(ports: PersonalRunPorts, record: ProposalRecord): Promise<AssistantProposal> {
  const names = await ports.runs.names([record.ownerUserId, ...(record.decidedBy ? [record.decidedBy] : [])]);
  return {
    id: record.id, runId: record.runId, projectId: record.projectId, audience: { kind: 'project', projectId: record.projectId },
    draftedBy: { ownerUserId: record.ownerUserId, label: assistantLabel(names.get(record.ownerUserId) ?? 'Former member') },
    fact: record.fact, interpretation: record.interpretation,
    change: { type: 'result', title: record.resultTitle, finding: record.resultFinding, evidence: record.resultEvidence,
      finishes: record.finishesWorkId ? { workId: record.finishesWorkId } : null },
    status: record.status,
    decidedBy: record.decidedBy ? { id: record.decidedBy, name: names.get(record.decidedBy) ?? 'Former member' } : null,
    decidedAt: record.decidedAt ? iso(record.decidedAt) : null, resultId: record.resultId, version: record.version,
    createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

/** Finds the proposal of a project the principal can see; an invisible one is reported as missing. */
async function visible(ports: PersonalRunPorts, principal: Principal, proposalId: unknown, action: 'read' | 'write') {
  if (!isId(proposalId)) throw notFound();
  const located = await ports.runs.findProposal(proposalId.toLowerCase(), { lock: action === 'write' });
  if (!located) throw notFound();
  try {
    const access = await ports.access.requireProject(principal, action, located.projectId, { lock: action === 'write' });
    return { proposal: located, access };
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound();
    throw error;
  }
}

/** Authority over the target: finishing an owned work item needs its owner or a manager. */
async function requireAuthority(ports: ProposalPorts, principal: Principal, proposal: ProposalRecord, level: 'viewer' | 'contributor' | 'manager') {
  if (!proposal.finishesWorkId || level === 'manager') return;
  const work = await ports.results.findWork(proposal.finishesWorkId, { lock: true });
  if (work?.ownerUserId && work.ownerUserId !== principal.id)
    throw new ForbiddenError('Only the owner of the work item or a project manager can decide this proposal', 'PROPOSAL_AUTHORITY_REQUIRED');
}

export function createAssistantProposalUseCases(uow: ProposalUnitOfWork) {
  async function decide(principal: Principal, proposalId: string, command: DecideAssistantProposalCommand | undefined, expected: number | undefined, outcome: 'accepted' | 'dismissed') {
    const person = ownerOf(principal);
    const version = expectedVersion(expected ?? command?.expectedVersion);
    return uow.run(async (ports) => {
      const { proposal, access } = await visible(ports, principal, proposalId, 'write');
      await requireAuthority(ports, principal, proposal, access.level);
      if (proposal.version !== version) throw new VersionConflictError(proposal.version, await proposalView(ports, proposal));
      if (proposal.status !== 'proposed') throw new ConflictError('The proposal was already decided', 'PROPOSAL_DECIDED');
      let resultId: string | null = null;
      if (outcome === 'accepted') {
        const work = proposal.finishesWorkId ? await ports.results.findWork(proposal.finishesWorkId, { lock: true }) : null;
        if (proposal.finishesWorkId && (!work || work.projectId !== proposal.projectId))
          throw new ConflictError('The work item no longer exists', 'PROPOSAL_TARGET_GONE');
        resultId = (await ports.results.recordResult(principal, proposal.projectId, {
          title: proposal.resultTitle, finding: proposal.resultFinding, evidence: proposal.resultEvidence,
          work: work ? [work.id] : [], finishes: work ? { id: work.id, expectedVersion: work.version } : undefined,
        })).id;
      }
      const updated = await ports.runs.updateProposal(proposal.id, { status: outcome, decidedBy: person, decidedAt: new Date(), resultId });
      await ports.events.record(principal, proposal.workspaceId, 'project.assistant_proposal_decided.v1', proposal.projectId,
        { proposalId: proposal.id, status: outcome, resultId });
      return proposalView(ports, updated);
    });
  }

  return {
    get: (principal: Principal, proposalId: string) => uow.run(async (ports) => proposalView(ports, (await visible(ports, principal, proposalId, 'read')).proposal)),

    async list(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<AssistantProposal>> {
      const window = page(query);
      return uow.run(async (ports) => {
        if (!isId(projectId)) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
        await ports.access.requireProject(principal, 'read', projectId.toLowerCase());
        const { items, total } = await ports.runs.listProposals(projectId.toLowerCase(), window);
        return { items: await Promise.all(items.map((item) => proposalView(ports, item))), total, ...window };
      });
    },

    accept: (principal: Principal, proposalId: string, command?: DecideAssistantProposalCommand, expected?: number) =>
      decide(principal, proposalId, command, expected, 'accepted'),
    dismiss: (principal: Principal, proposalId: string, command?: DecideAssistantProposalCommand, expected?: number) =>
      decide(principal, proposalId, command, expected, 'dismissed'),
  };
}

export type AssistantProposalUseCases = ReturnType<typeof createAssistantProposalUseCases>;
