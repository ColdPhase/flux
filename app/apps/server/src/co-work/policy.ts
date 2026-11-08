import { agentPauseRows, coworkUnitRows } from '@flux/db';
import { requireCoWorkCheckpointSources, requireCoWorkClaimEligibility, type CoWorkUnitPolicy } from '@flux/core';
import { requireTaskPrerequisitesMet } from '../work/task-graph.js';
import type { CoWorkClaimPolicy } from './claims.js';
import { coWorkTaskGraphLocks } from './graph.js';

/**
 * Server-owned co-work policy for the MCP path (#153, docs/development/cowork-coordination.md "MCP exposure").
 * Tool input, client metadata and project content never set these values. There is no project setting for review: the Review rule
 * and its project table are gone (C-9), and the one fixed rule that remains is that an author's own connection is never the reviewer
 * of its work in the same run.
 */
export const COWORK_UNIT_POLICY: CoWorkUnitPolicy = Object.freeze({ maximumRunUnits: 16 });

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
    pausedByPerson: (taskId, connectionId) => agentPauseRows(tx).pausedConnection(taskId, connectionId),
  }, unit, action),
  async requireCheckpointSources(tx, context, checkpoint, command) {
    await requireCoWorkCheckpointSources(checkpoint.progress, command, {
      materialsPresent: (ids) => coworkUnitRows(tx).materialsPresent(context.workspaceId, checkpoint.projectId, ids),
    });
  },
} satisfies CoWorkClaimPolicy);
