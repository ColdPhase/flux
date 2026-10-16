import { createHash, randomUUID } from 'node:crypto';
import {
  DM_LIMITS,
  RECEIPT_LIMITS,
  WORK_LIMITS,
  type DmMessage,
  type DmTaskCopyCommand,
  type DmTaskCopyPreview,
  type DmTaskCopyPreviewCommand,
  type DmTaskCopyResult,
  type DmThread,
  type MessageReceiptsQuery,
  type MessageReceiptsResult,
  type ObserveMessagesCommand,
  type ObserveMessagesResult,
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

function validRoot(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw missingMessage();
  return value.toLowerCase();
}

function page(query: PageQuery = {}) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError('limit must be an integer from 1 to 100');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) throw new InvalidInputError('offset must be an integer from 0 to 10000');
  return { limit, offset };
}

function counterpartOf(record: DmRecord, self: string): DmPerson | null {
  return record.pair?.find((p) => p.id !== self) ?? null;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'They';

/** 409 when the other person of a 1:1 no longer takes part: nothing is created, re-added or sent. */
async function requireCounterpart(ports: DmPorts, record: DmRecord, self: string) {
  const other = counterpartOf(record, self);
  if (!other || record.participants.some((p) => p.id === other.id)) return;
  const active = await ports.access.activePeople(record.workspaceId, [other.id]);
  if (!active.has(other.id)) {
    const error = new ConflictError(`${firstName(other.name)} is no longer in this workspace, so this conversation has nobody to send to.`, 'DM_RECIPIENT_UNAVAILABLE');
    error.details = { recipient: other };
    throw error;
  }
  const error = new ConflictError(`${firstName(other.name)} left this conversation. They can reopen it by messaging you.`, 'DM_RECIPIENT_LEFT');
  error.details = { recipient: other };
  throw error;
}

function toSummary(record: DmRecord, self: string): DmSummary {
  return {
    id: record.id, workspaceId: record.workspaceId, kind: record.kind, title: record.title,
    participants: record.participants, counterpart: counterpartOf(record, self), audience: { kind: 'dm', participantIds: record.participants.map((p) => p.id) },
    createdBy: record.createdBy, version: record.version, createdAt: record.createdAt.toISOString(),
    lastMessageAt: iso(record.lastMessageAt), lastMessageBody: record.lastMessageBody,
  };
}

function toMessage(record: DmMessageRecord): DmMessage {
  return { id: record.id, conversationId: record.dmId, authorId: record.authorId, body: record.body, source: null, sequence: record.sequence, createdAt: record.createdAt.toISOString(),
    threadRootId: record.threadRootId, replyCount: record.replyCount };
}

function messageIds(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new InvalidInputError(`${label} must list 1 to ${max} message ids`);
  const ids = value.map((item) => {
    if (typeof item !== 'string' || !UUID.test(item)) throw new InvalidInputError(`${label} must be message ids`);
    return item.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new InvalidInputError(`${label} must not repeat a message`);
  return ids;
}

/** 409 for a task copy whose preview is out of date: nothing was created; `details.preview` is the current one. */
export class TaskCopyChangedError extends ConflictError {
  constructor(preview: DmTaskCopyPreview) {
    super('Who can see the task, or what is copied, changed since the preview. Check it again.', 'TASK_COPY_CHANGED');
    this.details = { preview };
  }
}

/** The one thing a task copy may take from a message: a non-empty piece of its text, exactly as written. */
function chosenExcerpt(body: string, requested: unknown): string {
  const excerpt = requested === undefined || requested === null ? body : requested;
  if (typeof excerpt !== 'string' || !excerpt.trim()) throw new InvalidInputError('Choose the text to copy');
  if (!body.includes(excerpt)) throw new RuleViolationError('The excerpt is not part of this message', 'EXCERPT_NOT_IN_MESSAGE');
  if (excerpt.length > WORK_LIMITS.outcome) throw new RuleViolationError(`Choose a shorter part: a task holds up to ${WORK_LIMITS.outcome} characters`, 'EXCERPT_TOO_LONG');
  return excerpt;
}

function taskTitle(excerpt: string): string {
  const line = excerpt.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

const missingMessage = () => new NotFoundError('Message', 'DM_MESSAGE_NOT_FOUND');

async function found(ports: DmPorts, dmId: string): Promise<DmRecord> {
  const record = await ports.dms.find(dmId);
  if (!record) throw new NotFoundError('Direct message', 'DM_NOT_FOUND');
  return record;
}

/** The DM with a message window. Former participants who wrote in the window keep their names. */
async function peopleOf(ports: DmPorts, record: DmRecord, messages: DmMessageRecord[]): Promise<DmPerson[]> {
  const known = new Map<string, DmPerson>(record.participants.map((p) => [p.id, p]));
  const missing = [...new Set(messages.map((m) => m.authorId).filter((id) => !known.has(id)))];
  for (const extra of missing.length ? await ports.dms.names(missing) : []) known.set(extra.id, extra);
  return [...known.values()];
}

async function detail(ports: DmPorts, record: DmRecord, self: string, window: { limit: number; beforeSequence: number | null }): Promise<Dm> {
  const { messages, hasMoreBefore } = await ports.dms.window(record.id, window);
  const items = messages.map(toMessage);
  return {
    ...toSummary(record, self), messages: items, people: await peopleOf(ports, record, messages),
    messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? items[0]!.sequence : null, limit: window.limit },
  };
}

function validMessage(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw missingMessage();
  return value.toLowerCase();
}

async function taskCopyPreview(ports: DmPorts, principal: Principal, dm: DmRecord, messageId: string, requested: unknown, requestedProject: unknown): Promise<DmTaskCopyPreview> {
  const message = await ports.dms.message(dm.id, messageId);
  if (!message) throw missingMessage();
  const excerpt = chosenExcerpt(message.body, requested);
  const projects = await ports.taskCopy.targets(principal, dm.workspaceId);
  const wanted = requestedProject === undefined || requestedProject === null ? projects[0]?.id ?? null
    : typeof requestedProject === 'string' && UUID.test(requestedProject) ? requestedProject.toLowerCase() : (() => { throw new InvalidInputError('projectId must be a project id'); })();
  if (!wanted) return { messageId, excerpt, project: null, projects, audience: [], token: '' };
  const { people, projectName } = await ports.taskCopy.audience(principal, dm.workspaceId, wanted);
  const token = createHash('sha256').update(JSON.stringify({
    by: principal.id, dm: dm.id, message: message.id, body: createHash('sha256').update(message.body).digest('hex'), excerpt, project: wanted,
    readers: people.map((p) => `${p.kind}:${p.id}`).sort(),
  })).digest('base64url');
  return { messageId, excerpt, project: { id: wanted, name: projectName }, projects, audience: people, token };
}

export function createDmUseCases(uow: DmUnitOfWork) {
  async function sendMessage(principal: Principal, dmId: string, rootId: string | null, command: SendDmMessageCommand): Promise<DmMessage> {
    const authorId = person(principal);
    if (command && typeof command === 'object' && 'source' in command && (command as { source?: unknown }).source !== undefined)
      throw new RuleViolationError('Direct messages cannot cite project material yet', 'DM_SOURCE_UNSUPPORTED');
    if (command && typeof command === 'object' && (command as { attachmentIds?: unknown }).attachmentIds !== undefined)
      throw new RuleViolationError('Direct messages cannot carry files yet', 'DM_ATTACHMENTS_UNSUPPORTED');
    const input = normalizeMessage(command);
    // A reply's retry identity includes its root, so the same client id cannot be reused for another thread.
    const fingerprint = rootId ? createHash('sha256').update(`${rootId}:${input.fingerprint}`).digest('hex') : input.fingerprint;
    return uow.run(async (ports) => {
      await ports.access.requireDm(principal, 'dm.write', dmId, { lock: true });
      const dm = await found(ports, dmId);
      await ports.dms.lockClientMessage(dm.id, authorId, input.clientMessageId);
      const existing = await ports.dms.findMessage(dm.id, authorId, input.clientMessageId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new ConflictError('This clientMessageId was used for another message', 'IDEMPOTENCY_CONFLICT');
        return toMessage(existing);
      }
      if (rootId) {
        const root = await ports.dms.message(dm.id, rootId);
        if (!root || root.threadRootId) throw missingMessage();
      }
      // A 1:1 whose other person left has no audience besides the sender: refuse, do not store.
      await requireCounterpart(ports, dm, authorId);
      const message = await ports.dms.appendMessage({
        id: randomUUID(), workspaceId: dm.workspaceId, dmId: dm.id, authorId,
        clientMessageId: input.clientMessageId, requestFingerprint: fingerprint, body: input.body, threadRootId: rootId,
      });
      // The message id (an identifier, never content) lets notifications (#116) name the message.
      await ports.events.record(principal, dm.workspaceId, 'dm.message_sent.v1', dm.id, { messageId: message.id, ...(rootId ? { rootId } : {}) });
      return toMessage(message);
    });
  }

  return {
    async list(principal: Principal, workspaceId: string, query: PageQuery = {}): Promise<Page<DmSummary>> {
      const bounds = page(query);
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspaceId);
        const { items, total } = await ports.dms.listVisible(principal, workspaceId, bounds);
        return { items: items.map((item) => toSummary(item, principal.id)), total, ...bounds };
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
        if (others.length === 1) {
          const pairKey = [self, others[0]!].sort().join(':');
          await ports.dms.lockPair(workspaceId, pairKey);
          const existing = await ports.dms.findPair(workspaceId, pairKey);
          // The caller's own pair: if the other person left (or was removed), say so and stop.
          // Only they can reopen it, by messaging the caller; nobody is re-added on their behalf.
          // When both have left, the caller may take their own place again (and still cannot send).
          if (existing && existing.participants.length) await requireCounterpart(ports, existing, self);
          const active = await ports.access.activePeople(workspaceId, others);
          if (!active.has(others[0]!)) throw new RuleViolationError('Everyone in a direct message must be a person in this workspace', 'DM_PARTICIPANT_UNAVAILABLE');
          if (existing) {
            const rejoined = await ports.dms.addParticipant(workspaceId, existing.id, self);
            if (rejoined) await ports.dms.bumpVersion(existing.id);
            const dm = await detail(ports, await found(ports, existing.id), self, window);
            // Events are the last statement of a change: the seq lock is held from here to commit.
            if (rejoined) await ports.events.record(principal, workspaceId, 'dm.changed.v1', existing.id, { op: 'rejoined' });
            return { dm, created: false };
          }
          const record = await ports.dms.insert({ id: randomUUID(), workspaceId, kind: 'pair', pairKey, title: null, createdBy: self, participantIds: [self, others[0]!] });
          const dm = await detail(ports, record, self, window);
          await ports.events.record(principal, workspaceId, 'dm.created.v1', record.id, { kind: 'pair' });
          return { dm, created: true };
        }
        const active = await ports.access.activePeople(workspaceId, others);
        if (others.some((id) => !active.has(id))) throw new RuleViolationError('Everyone in a direct message must be a person in this workspace', 'DM_PARTICIPANT_UNAVAILABLE');
        const record = await ports.dms.insert({ id: randomUUID(), workspaceId, kind: 'group', pairKey: null, title: name, createdBy: self, participantIds: [self, ...others] });
        const dm = await detail(ports, record, self, window);
        await ports.events.record(principal, workspaceId, 'dm.created.v1', record.id, { kind: 'group' });
        return { dm, created: true };
      });
    },

    async get(principal: Principal, dmId: string, query?: ConversationWindowQuery): Promise<Dm> {
      const window = normalizeConversationWindow(query);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId);
        return detail(ports, await found(ports, dmId), principal.id, window);
      });
    },

    /** A message inherits the DM's audience. A retry with the same clientMessageId returns the original. */
    async send(principal: Principal, dmId: string, command: SendDmMessageCommand): Promise<DmMessage> {
      return sendMessage(principal, dmId, null, command);
    },

    /**
     * A private reply to a root of this DM (#536). The audience is exactly the DM's current participants: the same
     * `dm.write` check with the same locks, the same 1:1 recipient-left refusal, and a root that is not a message
     * of THIS DM (or is itself a reply) answers 404 like any invisible resource.
     */
    async reply(principal: Principal, dmId: string, rootId: string, command: SendDmMessageCommand): Promise<DmMessage> {
      return sendMessage(principal, dmId, validRoot(rootId), command);
    },

    /** One root and the newest window of its replies, for a current participant only. */
    async thread(principal: Principal, dmId: string, rootId: string, query?: ConversationWindowQuery): Promise<DmThread> {
      const window = normalizeConversationWindow(query);
      const root = validRoot(rootId);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId);
        const record = await found(ports, dmId);
        const rootMessage = await ports.dms.message(dmId, root);
        if (!rootMessage || rootMessage.threadRootId) throw missingMessage();
        const { messages, hasMoreBefore } = await ports.dms.threadWindow(dmId, root, window);
        const replies = messages.map(toMessage);
        return {
          root: toMessage(rootMessage), replies, people: await peopleOf(ports, record, [rootMessage, ...messages]),
          messagePage: { hasMoreBefore, nextBeforeSequence: hasMoreBefore ? replies[0]!.sequence : null, limit: window.limit },
        };
      });
    },

    /**
     * The caller observed these messages (#534). The viewer is always the authenticated person; the ids must be
     * messages of this DM, and a participant who left is refused like any other request. Idempotent, and a retry or a
     * second tab writes nothing. Only a new observation is announced, as an event without content.
     */
    async observe(principal: Principal, dmId: string, command: ObserveMessagesCommand): Promise<ObserveMessagesResult> {
      const viewer = person(principal);
      const ids = messageIds(command?.messageIds, RECEIPT_LIMITS.messagesPerCall, 'messageIds');
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId, { lock: true });
        const dm = await found(ports, dmId);
        const facts = await ports.dms.messageFacts(dmId, ids);
        if (facts.length !== ids.length) throw missingMessage();
        // Reading one's own words proves nothing; only other people's messages are observed.
        const observed = await ports.dms.observe(dm.workspaceId, dmId, viewer, facts.filter((f) => f.authorId !== viewer).map((f) => f.id));
        if (observed) await ports.events.record(principal, dm.workspaceId, 'dm.observed.v1', dm.id, {});
        return { observed };
      });
    },

    /**
     * "Seen by" for the caller's own author runs (#534). A run lists consecutive messages of ONE author at one level
     * (roots, or one thread's replies); the answer is the current participants who observed EVERY message of it.
     * The runs are checked against the stored messages, so a skipped message or a message of another DM is refused,
     * never trusted. Former participants are never named, whatever they observed.
     */
    async receipts(principal: Principal, dmId: string, query: MessageReceiptsQuery): Promise<MessageReceiptsResult> {
      const self = person(principal);
      if (!query || !Array.isArray(query.runs) || !query.runs.length || query.runs.length > RECEIPT_LIMITS.runsPerCall)
        throw new InvalidInputError(`runs must list 1 to ${RECEIPT_LIMITS.runsPerCall} runs`);
      const runs = query.runs.map((run) => messageIds(run, RECEIPT_LIMITS.messagesPerCall, 'each run'));
      if (runs.reduce((sum, run) => sum + run.length, 0) > RECEIPT_LIMITS.messagesPerQuery) throw new InvalidInputError('Too many messages in one request');
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId);
        const facts = new Map((await ports.dms.messageFacts(dmId, [...new Set(runs.flat())])).map((f) => [f.id, f]));
        const result: MessageReceiptsResult['runs'] = [];
        for (const run of runs) {
          const rows = run.map((id) => facts.get(id));
          if (rows.some((row) => !row)) throw missingMessage();
          const list = rows as NonNullable<(typeof rows)[number]>[];
          const root = list[0]!.threadRootId;
          if (list.some((row) => row.authorId !== self || row.threadRootId !== root))
            throw new RuleViolationError('Seen by is shown for your own consecutive messages only', 'RECEIPT_RUN_INVALID');
          const from = Math.min(...list.map((row) => row.sequence));
          const to = Math.max(...list.map((row) => row.sequence));
          const between = await ports.dms.levelRange(dmId, root, from, to);
          if (between.length !== run.length || between.some((row) => !facts.has(row.id)))
            throw new RuleViolationError('A run must list every message between its first and last', 'RECEIPT_RUN_INVALID');
          result.push({ messageIds: run, seenBy: await ports.dms.viewersOfAll(dmId, run, self) });
        }
        return { runs: result };
      });
    },

    /**
     * What copying a chosen part of one private message into a project task would share, and with whom (#537).
     * Changes nothing and records nothing. The token names the message version, the excerpt, the project and every
     * person who could open the task, so a commit applies only what the person saw.
     */
    async previewTaskCopy(principal: Principal, dmId: string, command: DmTaskCopyPreviewCommand): Promise<DmTaskCopyPreview> {
      person(principal);
      const messageId = validMessage(command?.messageId);
      return uow.run(async (ports) => {
        await ports.access.requireDm(principal, 'dm.read', dmId);
        const dm = await found(ports, dmId);
        await requireCounterpart(ports, dm, principal.id);
        return taskCopyPreview(ports, principal, dm, messageId, command.excerpt, command.projectId);
      });
    },

    /**
     * Creates the task from the approved excerpt only. The destination's audience is locked before it is read (the
     * sketch promotion's order: workspace, project, then the caller's membership, the DM and its participants), read
     * once, and checked against the preview's token. The task keeps no reference into the DM: its visible provenance is
     * who created it, when, and the excerpt itself.
     */
    async copyToTask(principal: Principal, dmId: string, command: DmTaskCopyCommand): Promise<DmTaskCopyResult> {
      person(principal);
      const messageId = validMessage(command?.messageId);
      const projectId = typeof command?.projectId === 'string' && UUID.test(command.projectId) ? command.projectId.toLowerCase() : null;
      if (!projectId) throw new InvalidInputError('projectId must be a project id');
      if (typeof command.token !== 'string' || !command.token) throw new InvalidInputError('token must be the preview token');
      if (typeof command.clientCommandId !== 'string' || !UUID.test(command.clientCommandId)) throw new InvalidInputError('clientCommandId must be a UUID');
      return uow.run(async (ports) => {
        const early = await ports.dms.find(dmId);
        if (!early) throw new NotFoundError('Direct message', 'DM_NOT_FOUND');
        await ports.taskCopy.lockDestination(early.workspaceId, projectId);
        await ports.access.requireDm(principal, 'dm.read', dmId, { lock: true });
        const dm = await found(ports, dmId);
        await requireCounterpart(ports, dm, principal.id);
        const preview = await taskCopyPreview(ports, principal, dm, messageId, command.excerpt, projectId);
        if (preview.token !== command.token) throw new TaskCopyChangedError(preview);
        const task = await ports.taskCopy.createTask(principal, projectId, {
          title: taskTitle(preview.excerpt), outcome: preview.excerpt, clientCommandId: command.clientCommandId,
        });
        return { task, project: preview.project! };
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
        if (dm.version !== expected) throw new VersionConflictError(dm.version, toSummary(dm, principal.id));
        await ports.dms.rename(dm.id, next);
        const renamed = toSummary(await found(ports, dm.id), principal.id);
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
