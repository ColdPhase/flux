import { coworkUnitRows } from '@flux/db';
import { NotFoundError, requireCoWorkCheckpointSources, requireCoWorkClaimEligibility, type CoWorkUnitPolicy } from '@flux/core';
import { requireTaskPrerequisitesMet } from '../work/task-graph.js';
import type { CoWorkClaimPolicy } from './claims.js';
import { coWorkTaskGraphLocks } from './graph.js';
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
