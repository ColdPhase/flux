import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@flux/contracts';
import { ConflictError, DomainError, redactedError } from '@flux/core';
import { sealedWorkScope, touchedSealedWorkspace } from '@flux/db';
import { taskUseDomainError } from '../work/task-use-errors.js';

// The one mapping from domain errors to HTTP answers (#85). The API registers it once on its root
// instance (app.ts), so every route plugin that does not set its own handler answers the same way.

/** The answer to a request without a valid session. */
export const UNAUTHENTICATED: Readonly<ApiError> = Object.freeze({ error: 'Authentication required', code: 'UNAUTHENTICATED' });

/** The answer to a refused request: `Forbidden` with the reason's code. */
export const forbidden = (code: string): ApiError => ({ error: 'Forbidden', code });

/** A domain error as its ApiError body, keeping its details (e.g. a version conflict's current state). */
export function domainErrorBody(error: DomainError): ApiError {
  return { ...error.details, error: error.message, code: error.code };
}

/** The F-030 database backstops (SQLSTATE FX409, the domain code as HINT; migration 0119) answer 409 with that code. */
const DATABASE_CONFLICTS = new Map([
  ['WORKSPACE_ENCRYPTED_AI_OFF', 'AI is always off in an encrypted workspace'],
  ['LAST_UNLOCK_PASSWORD', 'This space needs at least one unlock password'],
  ['WORKSPACE_ENCRYPTION_IMMUTABLE', 'A workspace\'s encryption cannot change'],
  // S2a backstops (migration 0120): a write the application did not seal, and a feature an encrypted space does not offer.
  ['WORKSPACE_PLAINTEXT_REFUSED', 'This is not available in an encrypted space yet'],
  ['WORKSPACE_ENCRYPTED_UNSUPPORTED', 'This is not available in an encrypted space'],
  // S2a-2c-3 (migration 0125): an event of an encrypted workspace whose data carries a free string.
  ['EVENT_CONTENT_REFUSED', 'This is not available in an encrypted space yet'],
]);
export function databaseConflict(error: unknown): unknown {
  for (let candidate = error as { code?: unknown; hint?: unknown; cause?: unknown } | undefined, depth = 0; candidate && depth < 3;
    candidate = candidate.cause as typeof candidate, depth += 1) {
    if (candidate.code === 'FX409' && typeof candidate.hint === 'string' && DATABASE_CONFLICTS.has(candidate.hint)) {
      return new ConflictError(DATABASE_CONFLICTS.get(candidate.hint)!, candidate.hint);
    }
  }
  return error;
}

/**
 * Maps DomainError to its status and ApiError body, and an unauthenticated request to 401. F-030 Error paths: every
 * request runs in `sealedWorkScope`; an unexpected error of a request that touched an encrypted workspace's seal is logged
 * and answered only as `redactedError` (class, code, SQLSTATE, constraint), never its message, detail or stack.
 */
export function useDomainErrors(app: FastifyInstance) {
  app.addHook('onRequest', (_request, _reply, done) => { sealedWorkScope.run({ sealed: false }, done); });
  app.setErrorHandler((error: FastifyError | DomainError, request, reply) => {
    // A storage task-use refusal (#238) is a known outcome; translate it without parsing a message.
    error = taskUseDomainError(error) as typeof error;
    error = databaseConflict(error) as typeof error;
    if (error instanceof DomainError) return reply.code(error.status).send(domainErrorBody(error));
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send(UNAUTHENTICATED);
    const status = (error as FastifyError).statusCode;
    if (touchedSealedWorkspace() && !(status && status < 500)) {
      const redacted = redactedError(error);
      request.log.error({ error: redacted.message }, 'Request of an encrypted workspace failed');
      return reply.code(500).send({ error: 'Internal Server Error', code: redacted.code ?? 'INTERNAL_ERROR' });
    }
    throw error;
  });
}
