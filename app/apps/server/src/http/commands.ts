import type { FastifyReply, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, IF_MATCH_HEADER } from '@flux/contracts';
import {
  assertAuthorized,
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
import { idempotencyRepository } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { single, versionEtag } from './headers.js';

// Shared HTTP plumbing for `/api/v1` command routes (issue #29 AC-4, reused by #69 and #107): the
// Idempotency-Key runner and replay checks. Header helpers are in headers.ts and the error mapping
// in errors.ts (#85); both are re-exported here for the route modules that import them from here.
export { expectedVersion, parseIfMatch, single, versionEtag } from './headers.js';
export { useDomainErrors } from './errors.js';

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
  /** Success status; a function decides from the result (e.g. 201 created, 200 existing). */
  status?: number | ((body: unknown) => number);
  /** Where the response ETag comes from; `true` means the body's own version. */
  etag?: boolean | ((body: unknown) => string | null);
  run: (principal: Principal, db: Database) => Promise<unknown>;
  /** Current authorization a stored response must pass before it is replayed. */
  replay: ReplayCheck;
}

export function commandRunner(db: Database, sessions: SessionResolver) {
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  /** Runs a state-changing command, at most once per Idempotency-Key when one is sent. */
  async function runCommand(request: FastifyRequest, spec: CommandSpec, connection: Database = db) {
    const actor = await principal(request);
    const key = parseIdempotencyKey(single(request.headers[IDEMPOTENCY_KEY_HEADER]));
    const etagOf = spec.etag === true ? versionEtag : spec.etag || (() => null);
    const execute = async (conn: Database): Promise<CommandResponse> => {
      const result = await spec.run(actor, conn);
      const status = typeof spec.status === 'function' ? spec.status(result) : spec.status ?? 200;
      return { status, body: result ?? null, etag: etagOf(result) };
    };
    let response: CommandResponse & { replayed?: boolean };
    if (key === null) {
      response = await execute(connection);
    } else {
      const workspaceId = spec.scope ? await visibleWorkspaceOf(actor, spec.scope, connection) : null;
      const hash = requestHash({ params: request.params, query: request.query, body: request.body ?? null, ifMatch: request.headers[IF_MATCH_HEADER] ?? null });
      response = await runIdempotent(connection, idempotencyRepository, { principal: actor, workspaceId, operation: spec.operation, key, requestHash: hash }, execute,
        (stored, conn) => spec.replay(actor, stored.body, conn));
    }
    return response;
  }

  /** Only send after any enclosing media fence and SQL transaction have completed. */
  function sendCommand(reply: FastifyReply, response: CommandResponse & { replayed?: boolean }) {
    if (response.etag) reply.header('etag', response.etag);
    if (response.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    if (response.status === 204) return reply.code(204).send();
    return reply.code(response.status).send(response.body);
  }

  async function command(request: FastifyRequest, reply: FastifyReply, spec: CommandSpec) {
    return sendCommand(reply, await runCommand(request, spec));
  }

  return { principal, command, runCommand, sendCommand };
}
