import type { AgentJsonValue } from '@flux/contracts';
import { coworkReviewRows, coworkUnitRows, type CoWorkReviewVerdict } from '@flux/db';
import { InvalidInputError, normalizeCoWorkSource, NotFoundError, requireCoWorkCheckpointSources, requireCoWorkClaimEligibility, type CoWorkUnitPolicy } from '@flux/core';
import { requireTaskPrerequisitesMet } from '../work/task-graph.js';
import type { CoWorkClaimPolicy } from './claims.js';
import { coWorkTaskGraphLocks } from './graph.js';
import type { CoWorkRequestPolicy } from './requests.js';
import type { CoWorkResponsePolicy } from './responses.js';

/**
 * Server-owned co-work policy for the MCP path (#153, docs/development/cowork-coordination.md "MCP exposure").
 * Tool input, client metadata and project content never set these values. `distinct_connection` is the contract
 * default (explicit same-owner review by another connection); a project-level `distinct_owner` choice needs its own
 * project-policy amendment.
 */
export const COWORK_UNIT_POLICY: CoWorkUnitPolicy = Object.freeze({ maximumRunUnits: 16, reviewSeparation: 'distinct_connection' });

/**
 * Responses without publication: the MCP path can decline a claimed request but not resolve it, because there is no
 * production response publisher yet and which grant authorizes publishing is an open peer question. The decline tool's
 * schema never reaches this provider; if anything does, it refuses instead of publishing.
 */
export const COWORK_RESPONSES_WITHOUT_PUBLICATION: CoWorkResponsePolicy = Object.freeze({
  async publishResponse(): Promise<never> { throw new NotFoundError('Response', 'COWORK_RESPONSE_UNAVAILABLE'); },
});

/**
 * Server-owned unit claim policy and its production providers (#153, "Unit claims over MCP", 2026-10-06). One live unit
 * per connection (CW-3's default; more needs its own grant, which does not exist yet) and the composition's longest
 * lease. Eligibility and checkpoint checks read the rows the composition already locked, or plain current rows, and
 * take no late lock.
 */
export const COWORK_CLAIM_POLICY: CoWorkClaimPolicy = Object.freeze({
  maximumConnectionUnits: 1,
  leaseSeconds: 300,
  prepareTaskLocks: (tx, context, units) => coWorkTaskGraphLocks(tx, context.workspaceId, units),
  requireEligible: (tx, context, unit, action) => requireCoWorkClaimEligibility({
    task: (taskId) => coworkUnitRows(tx).claimTask(context.workspaceId, taskId),
    requirePrerequisitesMet: (taskId) => requireTaskPrerequisitesMet(tx, context.workspaceId, taskId),
  }, unit, action),
  async requireCheckpointSources(tx, context, checkpoint, command) {
    await requireCoWorkCheckpointSources(checkpoint.progress, command, {
      materialsPresent: (ids) => coworkUnitRows(tx).materialsPresent(context.workspaceId, checkpoint.projectId, ids),
    });
  },
} satisfies CoWorkClaimPolicy);

/**
 * Server-owned request policy for the MCP path (#153 AC-2/AC-3): a lineage holds at most 32 requests, four levels of
 * delegation and four review rounds, so delegation and review cannot loop. Separation follows COWORK_UNIT_POLICY.
 */
export const COWORK_REQUEST_POLICY: CoWorkRequestPolicy = Object.freeze({
  limits: Object.freeze({ maximumRequests: 32, maximumDepth: 4, maximumReviewRounds: 4 }),
  reviewSeparation: COWORK_UNIT_POLICY.reviewSeparation,
});

const VERDICTS: readonly CoWorkReviewVerdict[] = ['passed', 'changes_requested'];
/**
 * The production response "publisher" (#153 AC-2/AC-4, 2026-10-17): it publishes nothing new. The recipient first
 * records its answer as an ordinary native record (a result, a message in the task's agents' thread, a doc version)
 * with the tools it already has, then resolves the request naming that record as `evidence`. So the response exists
 * before the resolution, no second content store appears, and the record's own grant already authorized writing it.
 * A review request must also carry a verdict, recorded pinned to the request's exact target and criteria; any other
 * kind refuses one. The composition checks afterwards that the evidence exists in this project now.
 */
const responsePublisher: CoWorkResponsePolicy = {
  async publishResponse(tx, runtime, request, response: { [key: string]: AgentJsonValue }) {
    const keys = Object.keys(response).sort().join(',');
    if (keys !== 'evidence' && keys !== 'evidence,verdict') throw new InvalidInputError('A response names its evidence and, for a review, a verdict');
    const evidence = normalizeCoWorkSource(response.evidence);
    if (evidence.type === 'github_pr') throw new InvalidInputError('Evidence is a native Flux record');
    const rows = coworkReviewRows(tx);
    const facts = await rows.request(runtime.workspaceId, request.projectId, request.id);
    if (!facts) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
    if (facts.kind !== 'review') {
      if (response.verdict !== undefined) throw new InvalidInputError('Only a review request takes a verdict', 'COWORK_VERDICT_NOT_REVIEW');
      return evidence;
    }
    if (!VERDICTS.includes(response.verdict as CoWorkReviewVerdict))
      throw new InvalidInputError('A review is resolved with a verdict: passed or changes_requested', 'COWORK_VERDICT_REQUIRED');
    await rows.record(runtime.workspaceId, request.projectId, { requestId: request.id, verdict: response.verdict as CoWorkReviewVerdict,
      evidenceRef: evidence, reviewerConnectionId: runtime.connectionId, reviewerOwnerId: runtime.ownerUserId });
    return evidence;
  },
};
export const COWORK_RESPONSE_POLICY: CoWorkResponsePolicy = Object.freeze(responsePublisher);
