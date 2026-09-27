import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, IF_MATCH_HEADER, type ApiError } from '@flux/contracts';
import {
  assertAuthorized,
  DomainError,
  InvalidInputError,
  parseIdempotencyKey,
  requestHash,
  runIdempotent,
  visibleWorkspaceOf,
  type ActionsByResource,
  type CommandResponse,
  type Database,
  type Principal,
  type ResourceRef,
  type ResourceType,
} from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

// Shared HTTP plumbing for `/api/v1` command routes (issue #29 AC-4, reused by #69): the
// domain error mapping, If-Match parsing and the Idempotency-Key runner.

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

/** Checks, before an idempotent replay, that the caller may still read what the stored body describes. */
export type ReplayCheck = (principal: Principal, body: unknown, db: Database) => Promise<void>;

export function bodyId(body: unknown): string {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : '';
}

/** A replay needs `action` on the object named by `id` (from the stored body or the route). */
export function requires<T extends ResourceType>(type: T, action: ActionsByResource[T], id: (body: unknown) => string): ReplayCheck {
  return (principal, body, db) => assertAuthorized(principal, action, { type, id: id(body) } as ResourceRef<T>, db);
}

export interface CommandSpec {
  /** Stable operation name used to scope idempotency keys. */
  operation: string;
  /** The object whose workspace scopes the idempotency key; null outside a workspace. */
  scope: ResourceRef | null;
  status?: number;
  /** Where the response ETag comes from; `true` means the body's own version. */
  etag?: boolean | ((body: unknown) => string | null);
  run: (principal: Principal, db: Database) => Promise<unknown>;
  /** Current authorization a stored response must pass before it is replayed. */
  replay: ReplayCheck;
}

/** Maps DomainError to its status and ApiError body inside the plugin that calls it. */
export function useDomainErrors(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) {
      const payload: ApiError = { ...error.details, error: error.message, code: error.code };
      return reply.code(error.status).send(payload);
    }
    if ((error as FastifyError).statusCode === 401) {
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' } satisfies ApiError);
    }
    throw error;
  });
}

export function commandRunner(db: Database, sessions: SessionResolver) {
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  /** Runs a state-changing command, at most once per Idempotency-Key when one is sent. */
  async function command(request: FastifyRequest, reply: FastifyReply, spec: CommandSpec) {
    const actor = await principal(request);
    const key = parseIdempotencyKey(single(request.headers[IDEMPOTENCY_KEY_HEADER]));
    const etagOf = spec.etag === true ? versionEtag : spec.etag || (() => null);
    const execute = async (conn: Database): Promise<CommandResponse> => {
      const result = await spec.run(actor, conn);
      return { status: spec.status ?? 200, body: result ?? null, etag: etagOf(result) };
    };
    let response: CommandResponse & { replayed?: boolean };
    if (key === null) {
      response = await execute(db);
    } else {
      const workspaceId = spec.scope ? await visibleWorkspaceOf(actor, spec.scope, db) : null;
      const hash = requestHash({ params: request.params, query: request.query, body: request.body ?? null, ifMatch: request.headers[IF_MATCH_HEADER] ?? null });
      response = await runIdempotent(db, { principal: actor, workspaceId, operation: spec.operation, key, requestHash: hash }, execute,
        (stored, conn) => spec.replay(actor, stored.body, conn));
    }
    if (response.etag) reply.header('etag', response.etag);
    if (response.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    if (response.status === 204) return reply.code(204).send();
    return reply.code(response.status).send(response.body);
  }

  return { principal, command };
}
