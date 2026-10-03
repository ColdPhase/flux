import type { FastifyRequest } from 'fastify';
import { IF_MATCH_HEADER } from '@flux/contracts';
import { InvalidInputError } from '@flux/core';

// Request header helpers shared by `/api/v1` routes (#85): one value per header, If-Match and the
// body's expectedVersion, and the ETag of a versioned body.

export function single(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    if (value.length > 1) throw new InvalidInputError('Header must appear once', 'INVALID_HEADER');
    return value[0];
  }
  return value;
}

/** `If-Match: "<version>"` (or a bare integer) → version; absent → undefined. `*` and lists are rejected. */
export function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*"?([1-9][0-9]{0,9})"?\s*$/.exec(value);
  if (!match) throw new InvalidInputError('If-Match must be a single quoted version such as "3"', 'INVALID_PRECONDITION');
  return Number(match[1]);
}

/** Combines If-Match with a body `expectedVersion`; both may be given only if they agree. */
export function expectedVersion(request: FastifyRequest): number | undefined {
  const header = parseIfMatch(single(request.headers[IF_MATCH_HEADER]));
  const body = (request.body as { expectedVersion?: number } | undefined)?.expectedVersion;
  if (header !== undefined && body !== undefined && header !== body) throw new InvalidInputError('If-Match and expectedVersion disagree', 'INVALID_PRECONDITION');
  return header ?? body;
}

/** `ETag: "<version>"` for a response body with a numeric version. */
export function versionEtag(value: unknown) {
  const version = (value as { version?: unknown } | null)?.version;
  return typeof version === 'number' ? `"${version}"` : null;
}
