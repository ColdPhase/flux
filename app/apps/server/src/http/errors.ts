import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@flux/contracts';
import { ConflictError, DomainError } from '@flux/core';
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

/** Maps DomainError to its status and ApiError body, and an unauthenticated request to 401. */
export function useDomainErrors(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    // A storage task-use refusal (#238) is a known outcome; translate it without parsing a message.
    error = taskUseDomainError(error) as typeof error;
    error = databaseConflict(error) as typeof error;
    if (error instanceof DomainError) return reply.code(error.status).send(domainErrorBody(error));
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send(UNAUTHENTICATED);
    throw error;
  });
}
