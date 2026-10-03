import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@flux/contracts';
import { DomainError } from '@flux/core';

// The one mapping from domain errors to HTTP answers (#85). The API registers it once on its root
// instance (app.ts), so every route plugin that does not set its own handler answers the same way.

/** The answer to a request without a valid session. */
export const UNAUTHENTICATED: ApiError = { error: 'Authentication required', code: 'UNAUTHENTICATED' };

/** The answer to a refused request: `Forbidden` with the reason's code. */
export const forbidden = (code: string): ApiError => ({ error: 'Forbidden', code });

/** A domain error as its ApiError body, keeping its details (e.g. a version conflict's current state). */
export function domainErrorBody(error: DomainError): ApiError {
  return { ...error.details, error: error.message, code: error.code };
}

/** Maps DomainError to its status and ApiError body, and an unauthenticated request to 401. */
export function useDomainErrors(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send(domainErrorBody(error));
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send(UNAUTHENTICATED);
    throw error;
  });
}
