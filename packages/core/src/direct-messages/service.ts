import { randomUUID } from 'node:crypto';
import {
  DM_LIMITS,
  type ConversationMessage,
  type ConversationWindowQuery,
  type CreateDmCommand,
  type Dm,
  type DmPerson,
  type DmSummary,
  type Page,
  type PageQuery,
  type SendDmMessageCommand,
  type UpdateDmCommand,
} from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, PreconditionRequiredError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import { normalizeConversationWindow, normalizeMessage } from '../conversation/commands.js';
import type { Principal } from '../principal.js';
import type { DmMessageRecord, DmPorts, DmRecord, DmUnitOfWork } from './ports.js';

// Direct-message use cases (issue #107). Each runs in one unit of work: it asks the access port
// first (reads: `dm.read`; changes: `dm.write` with the DM locked), then changes rows through the
// repository and records one event last, so the decision, the change and the stream event commit
// together. Messages reuse the #36 rules: `normalizeMessage` (body, clientMessageId, request
// fingerprint), per-conversation sequences and `normalizeConversationWindow` for paging.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (date: Date | null) => (date ? date.toISOString() : null);

function person(principal: Principal): string {
  // Agents take part in DMs only through an explicit participant grant, which is not in this slice.
  if (principal.kind !== 'human') throw new NotFoundError('Direct message', 'DM_NOT_FOUND');
  return principal.id;
}

function userIds(value: unknown, self: string): string[] {
  if (!Array.isArray(value)) throw new InvalidInputError('participantIds must list the other people');
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !UUID.test(item)) throw new InvalidInputError('participantIds must be user ids');
    const normalized = item.toLowerCase();
    if (normalized !== self) ids.add(normalized);
  }
  if (!ids.size) throw new InvalidInputError('Name at least one other person');
  if (ids.size > DM_LIMITS.others) throw new InvalidInputError(`A direct message has at most ${DM_LIMITS.others + 1} people`);
  return [...ids].sort();
}

function title(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidInputError('title must be a string or null');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > DM_LIMITS.title) throw new InvalidInputError(`title must be at most ${DM_LIMITS.title} characters`);
  return trimmed;
}

function page(query: PageQuery = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}

function toSummary(record: DmRecord): DmSummary {
  return {
    id: record.id, workspaceId: record.workspaceId, kind: record.kind, title: record.title,
    participants: record.participants, audience: { kind: 'dm', participantIds: record.participants.map((p) => p.id) },
    createdBy: record.createdBy, version: record.version, createdAt: record.createdAt.toISOString(),
    lastMessageAt: iso(record.lastMessageAt), lastMessageBody: record.lastMessageBody,
  };
}

function toMessage(record: DmMessageRecord): ConversationMessage {
  return { id: record.id, conversationId: record.dmId, authorId: record.authorId, body: record.body, source: null, sequence: record.sequence, createdAt: record.createdAt.toISOString() };
}

async function found(ports: DmPorts, dmId: string): Promise<DmRecord> {
  const record = await ports.dms.find(dmId);
  if (!record) throw new NotFoundError('Direct message', 'DM_NOT_FOUND');
  return record;
}

/** The DM with a message window. Former participants who wrote in the window keep their names. */
async function detail(ports: DmPorts, record: DmRecord, window: { limit: number; beforeSequence: number | null }): Promise<Dm> {
  const { messages, hasMoreBefore } = await ports.dms.window(record.id, window);
  const known = new Map<string, DmPerson>(record.participants.map((p) => [p.id, p]));
  const missing = [...new Set(messages.map((m) => m.authorId).filter((id) => !known.has(id)))];
  for (const extra of missing.length ? await ports.dms.names(missing) : []) known.set(extra.id, extra);
  const items = messages.map(toMessage);
  return {
    ...toSummary(record), messages: items, people: [...known.values()],
    messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? items[0]!.sequence : null, limit: window.limit },
  };
}

export function createDmUseCases(uow: DmUnitOfWork) {
  return {
    async list(principal: Principal, workspaceId: string, query: PageQuery = {}): Promise<Page<DmSummary>> {
      const bounds = page(query);
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspaceId);
        const { items, total } = await ports.dms.listVisible(principal, workspaceId, bounds);
        return { items: items.map(toSummary), total, ...bounds };
      });
    },

    /**
     * One other person: the pair's single 1:1 DM, created once (`created: true`) and otherwise
     * returned, with the caller joining again if they had left. More people: a new group DM.
     */
    async create(principal: Principal, workspaceId: string, command: CreateDmCommand): Promise<{ dm: Dm; created: boolean }> {
      const self = person(principal);
      const others = userIds(command?.participantIds, self);
      const name = title(command?.title);
      if (others.length === 1 && name) throw new RuleViolationError('Only group direct messages have a title', 'DM_PAIR_UNTITLED');
      const window = normalizeConversationWindow();
      return uow.run(async (ports) => {
        await ports.access.requireCreate(principal, workspaceId);
        const active = await ports.access.activePeople(workspaceId, others);
        if (others.some((id) => !active.has(id))) throw new RuleViolationError('Everyone in a direct message must be a person in this workspace', 'DM_PARTICIPANT_UNAVAILABLE');
        if (others.length === 1) {
          const pairKey = [self, others[0]!].sort().join(':');
          await ports.dms.lockPair(workspaceId, pairKey);
          const existing = await ports.dms.findPair(workspaceId, pairKey);
          if (existing) {
            const rejoined = await ports.dms.addParticipant(workspaceId, existing.id, self);
            if (rejoined) await ports.dms.bumpVersion(existing.id);
            const dm = await detail(ports, await found(ports, existing.id), window);
            // Events are the last statement of a change: the seq lock is held from here to commit.
            if (rejoined) await ports.events.record(principal, workspaceId, 'dm.changed.v1', existing.id, { op: 'rejoined' });
            return { dm, created: false };
          }
          const record = await ports.dms.insert({ id: randomUUID(), workspaceId, kind: 'pair', pairKey, title: null, createdBy: self, participantIds: [self, others[0]!] });
          const dm = await detail(ports, record, window);
          await ports.events.record(principal, workspaceId, 'dm.created.v1', record.id, { kind: 'pair' });
          return { dm, created: true };
        }
        const record = await ports.dms.insert({ id: randomUUID(), workspaceId, kind: 'group', pairKey: null, title: name, createdBy: self, participantIds: [self, ...others] });
        const dm = await detail(ports, record, window);
        await ports.events.record(principal, workspaceId, 'dm.created.v1', record.id, { kind: 'group' });
        return { dm, created: true };
      });
    },

    async get(principal: Principal, dmId: string, query?: ConversationWindowQuery): Promise<Dm> {
      const window = normalizeConversationWindow(query);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId);
        return detail(ports, await found(ports, dmId), window);
      });
    },

    /** A reply inherits the DM's audience. A retry with the same clientMessageId returns the original. */
    async send(principal: Principal, dmId: string, command: SendDmMessageCommand): Promise<ConversationMessage> {
      const authorId = person(principal);
      if (command && typeof command === 'object' && 'source' in command && (command as { source?: unknown }).source !== undefined)
        throw new RuleViolationError('Direct messages cannot cite project material yet', 'DM_SOURCE_UNSUPPORTED');
      const input = normalizeMessage(command);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.write', dmId, { lock: true });
        const dm = await found(ports, dmId);
        await ports.dms.lockClientMessage(dm.id, authorId, input.clientMessageId);
        const existing = await ports.dms.findMessage(dm.id, authorId, input.clientMessageId);
        if (existing) {
          if (existing.requestFingerprint !== input.fingerprint) throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
          return toMessage(existing);
        }
        const message = await ports.dms.appendMessage({
          id: randomUUID(), workspaceId: dm.workspaceId, dmId: dm.id, authorId,
          clientMessageId: input.clientMessageId, requestFingerprint: input.fingerprint, body: input.body,
        });
        await ports.events.record(principal, dm.workspaceId, 'dm.message_sent.v1', dm.id, {});
        return toMessage(message);
      });
    },

    async rename(principal: Principal, dmId: string, command: UpdateDmCommand): Promise<DmSummary> {
      person(principal);
      const next = title(command?.title);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.write', dmId, { lock: true });
        const dm = await found(ports, dmId);
        if (dm.kind === 'pair') throw new RuleViolationError('Only group direct messages have a title', 'DM_PAIR_UNTITLED');
        const expected = command?.expectedVersion;
        if (expected === undefined || expected === null) throw new PreconditionRequiredError();
        if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new InvalidInputError('expectedVersion must be a positive integer');
        if (dm.version !== expected) throw new VersionConflictError(dm.version, toSummary(dm));
        await ports.dms.rename(dm.id, next);
        const renamed = toSummary(await found(ports, dm.id));
        await ports.events.record(principal, dm.workspaceId, 'dm.changed.v1', dm.id, { op: 'renamed' });
        return renamed;
      });
    },

    /** Leaving ends access at once: the next request and stream delivery no longer see the DM. */
    async leave(principal: Principal, dmId: string): Promise<void> {
      const self = person(principal);
      await uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.write', dmId, { lock: true });
        const dm = await found(ports, dmId);
        if (!await ports.dms.removeParticipant(dm.id, self)) throw new NotFoundError('Direct message', 'DM_NOT_FOUND');
        await ports.dms.bumpVersion(dm.id);
        // Recorded after the removal, so the audience is the remaining participants only.
        await ports.events.record(principal, dm.workspaceId, 'dm.changed.v1', dm.id, { op: 'left' });
      });
    },
  };
}

export type DmUseCases = ReturnType<typeof createDmUseCases>;
