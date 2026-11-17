import { lockedReadScope, lockedWorkspacesOfRead, type Database } from '@flux/db';
import type { FastifyInstance } from 'fastify';
import { NEEDS_YOU_ASIDE_PATH, NEEDS_YOU_PATH, type ResolveNeedsYouCommand } from '@flux/contracts';
import { aiAllowedInProject } from '../access/ai-gate.js';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { needsYouUseCases } from './adapters.js';
import { withAgentOwners } from './agent-owners.js';
import { lockedItemsOf } from '../encryption/lock-gate.js';
import { assistantChangeUseCases } from '../assistant/changes.js';
import type { Provider as GithubProvider } from '../github/adapters.js';

/** `github`: the read-only App provider, for an approved pull-request link of a local client (#1419). */
interface Options { db: Database; sessions: SessionResolver; github?: GithubProvider | null }

// One flat shape: core checks which fields an action needs (Ajv's removeAdditional would mutate `oneOf` branches).
const command = { type: 'object', required: ['action'], additionalProperties: false, properties: {
  action: { type: 'string', enum: ['done', 'decline', 'snooze'] }, until: { type: 'string', maxLength: 40 }, untilWorkId: { type: 'string', maxLength: 40 },
} } as const;

/**
 * `/api/v1/needs-you`: the Inbox queue of the signed-in person and what they do with its items (#342).
 * Each handler resolves the live session and calls one core use case; an item the person cannot read
 * now is not listed and answers like one that never existed. Resolving is idempotent by nature (the
 * same choice stores the same state), so no Idempotency-Key is needed.
 */
export async function needsYouRoutes(app: FastifyInstance, { db, sessions, github = null }: Options) {
  useDomainErrors(app);
  // The owner's undecided waiting assistant changes join the queue as questions (F-027 AST-5.6).
  const assistant = assistantChangeUseCases(db, undefined, github);
  // F-029: the assistant's waiting changes of a workspace whose AI is off are left out (and so cannot be resolved).
  const use = needsYouUseCases(db, { waiting: async (userId) => {
    const visible = [];
    for (const change of await assistant.inbox(userId)) if (await aiAllowedInProject(db, change.projectId)) visible.push(change);
    return visible;
  } });
  const principal = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => (await sessions.requirePrincipal(request)).principal;

  // A cross-workspace read (F-030): the lock gate leaves a locked encrypted space's items out of the lists and names the space; "N for later" and
  // "N done today" leave them out too, so each count is its list (pre-review P2-4).
  app.get(NEEDS_YOU_PATH, async (request, reply) => {
    const locked = lockedWorkspacesOfRead();
    const queue = await use.list(await principal(request), await lockedItemsOf(db, [...locked.keys()]));
    await withAgentOwners(db, queue.items);
    return reply.header('cache-control', 'no-store').send(queue);
  });

  // What "2 for later" and "4 done today" open (#1424 E); bringing one back is the DELETE below.
  app.get(NEEDS_YOU_ASIDE_PATH, async (request, reply) => {
    const aside = await use.aside(await principal(request));
    await withAgentOwners(db, [...aside.later, ...aside.done].map((entry) => entry.item));
    return reply.header('cache-control', 'no-store').send(aside);
  });

  // Done, Snooze and Put back read the person's whole queue again to find the item: a locked encrypted space's rows are skipped there, as in
  // the lists, rather than refusing the person's choice on another space's item (pre-review P2-4). What they change is still written through
  // the sealing path, which refuses a locked space's objects.
  const skippingLocked = <T>(work: () => Promise<T>) => lockedReadScope.run({ skipped: new Set<string>() }, work);
  app.post<{ Params: { key: string }; Body: ResolveNeedsYouCommand }>(`${NEEDS_YOU_PATH}/:key`, { schema: { body: command } },
    async (request) => { const who = await principal(request); return skippingLocked(() => use.resolve(who, request.params.key, request.body)); });

  app.delete<{ Params: { key: string } }>(`${NEEDS_YOU_PATH}/:key`, async (request, reply) => {
    const who = await principal(request);
    await skippingLocked(() => use.restore(who, request.params.key));
    return reply.code(204).send();
  });
}
