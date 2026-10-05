import { NotFoundError, type CoWorkUnitPolicy } from '@flux/core';
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
