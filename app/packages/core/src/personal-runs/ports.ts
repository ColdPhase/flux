import type { AgentChatMessage, ApiKeyModels, AgentChatSummary, AssistantPlace, MessageFile, MessageContribution, PlanModels } from '@flux/contracts';
import type {
  AiPrice, AiProviderKind, AgentRuntimePayer, AgentMayDo, AssistantEngine, AssistantRunCostState, AssistantRunEndReason,
  AssistantRunKind, AssistantRunStatus, AssistantSourceRef, AgentColour, PersonalRunTokenGrant,
} from '@flux/contracts';
import type { AssistantIdentityPort } from '../assistant/ports.js';
import type { Principal } from '../principal.js';
import type { Paged, PageWindow } from '../work/ports.js';
import type { TaskFacts } from './brief.js';
import type { KeptPrivateText } from './web-addresses.js';

/**
 * Ports of the personal assistant runs (issue #68, decision O-008). Core states what it needs;
 * the server and worker implement them with the access policy (`policyPersonalRunAccess`),
 * `@flux/db` rows, `recordEvent`, pg-boss and — later — the provider adapter and #124's key
 * connection. Nothing in `packages/core/src/personal-runs` imports those adapters.
 */

export interface EnablementRecord {
  ownerUserId: string;
  agentId: string;
  workspaceId: string;
  /** The API key the agent's model belongs to (`server`); null on a plan (`runtime`). */
  connectionId: string | null;
  /** The provider of the agent's connection; on a plan it names the CLI (`openai`: Codex, else Claude Code). */
  provider: AiProviderKind;
  /** `runtime`: the owner's own Claude Code or Codex (F-022 AIM-3); `connectionId` is then null. */
  engine: AssistantEngine;
  /** The agent's one model, from its connection's list (F-027 AST-11); null reads as that connection's default. */
  assistantModel: string | null;
  instructions: string;
  colour: AgentColour;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What a run tells the model besides the request (F-036 AG-1): the agent's name, saved instructions and the items its owner asked it to remember. */
export interface AgentBrief { name: string; instructions: string; memory: string[]; /** The agent's colour (AG-1); Show everyone keeps it on the posted message (#1232). */ colour?: AgentColour }

/** Today's use of one API key's daily budget (#854), by everything that runs on it. */
export interface KeySpend { budgetCents: number; chargedMicros: number; reservedMicros: number; resetsAt: Date }

export interface RunRecord {
  id: string;
  workspaceId: string;
  /** The run's place (#842): a space (`projectId`, with `conversationId` unless it is the space's main conversation), a direct message (`dmId`) or neither: the private chat with its agent. */
  projectId: string | null;
  conversationId: string | null;
  dmId: string | null;
  /** 0032 (#1016): the root message of the DM thread the run belongs to; null for the DM's main line and every other place. */
  dmThreadRootId: string | null;
  ownerUserId: string;
  agentId: string;
  connectionId: string | null;
  clientRunId: string;
  requestFingerprint: string;
  kind: AssistantRunKind;
  prompt: string;
  targetSketchId: string | null;
  targetThoughtId: string | null;
  continuesRunId: string | null;
  retryOfRunId: string | null;
  status: AssistantRunStatus;
  stoppedAtStage: 'before_read' | 'before_dispatch' | 'before_commit' | null;
  stopRequestedAt: Date | null;
  costState: AssistantRunCostState;
  reservedMicros: number;
  chargedMicros: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The connection's provider and model the run was reserved on (F-020). */
  provider: AiProviderKind;
  model: string;
  answerBody: string | null;
  answerTruncated: boolean;
  answerSources: AssistantSourceRef[];
  committedAt: Date | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  /** 0100 (F-022 T5, F-027 A2): the engine, the run's own end states and its MCP token (never the token itself). */
  engine: AssistantEngine;
  endReason: AssistantRunEndReason | null;
  planLimitResetsAt: Date | null;
  /** A request paused by its connection's limit waits, queued, until then (#854); null otherwise. */
  resumeAt: Date | null;
  /** When the money was held: the key's day this run counts on (#854). */
  reservedAt: Date;
  /** The most one request of this run can cost at the key's price; null on a plan and before it starts. */
  largestRequestMicros: number | null;
  stopAcknowledgedAt: Date | null;
  answerRedacted: boolean;
  runTokenJti: string | null;
  runTokenClosedAt: Date | null;
  runTools: string[];
  mcpResultBytes: number;
  /** A tool result passed the MCP route's bound for one call or for the run (F-022 "Caps"). */
  mcpLimit: 'call' | 'run' | null;
  /** 0108 (F-027 A4): what started the run, and a background run's short name for the lane's lines. */
  authority: 'owner_request' | 'owner_schedule';
  backgroundLabel: string | null;
  /** 0008 (#856): the task a `task` run works on; null for every other kind. */
  workId: string | null;
  /** 0008 (#856): who pressed Stop. */
  stopRequestedBy: string | null;
  /** 0009 (#841): the run whose question this run answers, and how many questions in a row led here. */
  askedByRunId: string | null;
  exchangeTurn: number;
  /** 0115 (F-029): the space's AI policy epoch the run was admitted under; every later step requires it. Null outside a space (a DM, a chat). */
  aiEpoch: number | null;
  /** #842: Show everyone posted the answer, or Dismiss put it away. */
  shownAt: Date | null;
  dismissedAt: Date | null;
}

/** Where a run belongs, from its row: a space, a direct message, or the private chat with its agent (#842). */
export function placeOf(run: Pick<RunRecord, 'projectId' | 'conversationId' | 'dmId' | 'dmThreadRootId' | 'agentId'>): AssistantPlace {
  return run.projectId !== null ? { kind: 'space', projectId: run.projectId, conversationId: run.conversationId }
    : run.dmId !== null ? { kind: 'dm', dmId: run.dmId, threadRootId: run.dmThreadRootId } : { kind: 'chat', agentId: run.agentId };
}
/**
 * A run whose answer is its owner's alone until Show everyone: what `/ai` and a chat ask, and what a schedule's run writes (#858, #1104): a schedule
 * runs in its agent's private chat and its result is a message only its owner reads, whom Show everyone then lets share it. Only a task's result is posted.
 */
export const isPrivateAnswer = (run: Pick<RunRecord, 'kind'>) => run.kind === 'ask' || run.kind === 'summarize' || run.kind === 'map_thought' || run.kind === 'scheduled';
/** A run the owner said to the agent in its chat, or `/ai` in a place: it has the chat's turns behind it. A schedule is a single instruction. */
export const isAsked = (run: Pick<RunRecord, 'kind'>) => run.kind === 'ask' || run.kind === 'summarize' || run.kind === 'map_thought';

/**
 * How a run may end at a standing check: one of its statuses, or `ai_off` (F-029), which is recorded as `stopped` with
 * `end_reason = 'ai_off'`.
 */
export type RunEndStatus = RunRecord['status'] | 'ai_off';

export type NewRun = Pick<RunRecord, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'dmId' | 'dmThreadRootId' | 'ownerUserId' | 'agentId' | 'connectionId'
  | 'clientRunId' | 'requestFingerprint' | 'kind' | 'prompt' | 'targetSketchId' | 'targetThoughtId' | 'continuesRunId' | 'retryOfRunId'
  | 'reservedMicros' | 'provider' | 'model' | 'aiEpoch'> & { engine?: AssistantEngine; authority?: RunRecord['authority']; backgroundLabel?: string | null; workId?: string | null; askedByRunId?: string | null; exchangeTurn?: number;
    /** A paused request: queued until then, with the reason it waits (#854). */
    resumeAt?: Date | null; endReason?: AssistantRunEndReason | null; planLimitResetsAt?: Date | null };
export type RunChanges = Partial<Pick<RunRecord, 'status' | 'stoppedAtStage' | 'stopRequestedAt' | 'stopRequestedBy' | 'costState' | 'chargedMicros'
  | 'inputTokens' | 'outputTokens' | 'answerBody' | 'answerTruncated' | 'answerSources' | 'committedAt' | 'dispatchedAt' | 'completedAt'
  | 'endReason' | 'planLimitResetsAt' | 'stopAcknowledgedAt' | 'answerRedacted' | 'resumeAt' | 'reservedMicros' | 'reservedAt' | 'largestRequestMicros'
  | 'shownAt' | 'dismissedAt'>>;

/** Rows a run may read. The use cases authorize the run's agent (and owner) before calling these. */
export interface MessageSource {
  contribution?: MessageContribution; files?: MessageFile[]; id: string; sequence: number; body: string;
  /**
   * Who wrote it, as people see it (#1160, `authorLabel`): a person's name, or an agent with whose it is, "Fieldbot (Jonas's agent)". The
   * repository gives the stored names; the run names only who can read the space now (`namedAuthors`).
   */
  authorName: string;
  /** `ownerUserId`: an agent's owner, whom the run names only while they can read the space. */
  author: { kind: 'human' | 'agent'; id: string; ownerUserId?: string };
  /** #1064: when it was written; whether its author changed the words since; the agent whose answer its author posted with Show everyone. */
  createdAt: Date; edited?: boolean; via?: string | null;
  /**
   * #1064, a space's main conversation only: the conversation (thread) it belongs to, and that thread's opening words; null words when
   * its author deleted the opening message.
   */
  conversationId?: string; thread?: string | null;
}
/** One call of a place, as a run is told it (F-041): who started it and who was in it, never what was said. A running call has no `endedAt`. */
export interface CallSource { id: string; startedAt: Date; endedAt: Date | null; startedBy: string; joinedBy: string[] }
/** One place of the owner's runs (#842): exactly one of these. */
export type RunPlaceFilter = { conversationId: string } | { spaceId: string } | { dmId: string; dmThreadRootId: string | null } | { chatAgentId: string };

export interface PlaceNames { spaceName: string | null; task: { number: number; title: string } | null; people: { id: string; name: string }[] }
export interface WorkSource { id: string; version: number; number: number; title: string; outcome: string; status: string }
export interface ThoughtSource { id: string; sketchId: string; version: number; text: string; sketchScope: 'project' | 'private'; sketchProjectId: string | null }

/** Rows only; the repository makes no access decisions (the use cases ask {@link PersonalRunAccess}). */
export interface PersonalRunRepository {
  /** The pages the run read on the web (#918), each once, in the order they were first read. */
  webReads(runId: string): Promise<{ finalUrl: string; outcome: string; writable: boolean }[]>;
  /** #1217: the pictures an agent attached to its answer in its private chat, in order. Absent from a port that serves no chat. */
  runPictures?(runId: string): Promise<MessageFile[]>;
  /** The run's searches (#954): their queries and the addresses the answers cited, each once, in the order found. */
  webSearches(runId: string): Promise<{ queries: string[]; cited: string[] }>;
  /** Records what one response's web search brought (#954), before any tool call the same response asked for runs. */
  addWebSearch(runId: string, found: WebSearchFound): Promise<void>;
  /** A search the owner's CLI started (#1065, C-30), written with its query when the CLI shows it then; returns its row. */
  startWebSearch(runId: string, query: string): Promise<string>;
  /** The results of that search came back, normalized and bounded, and `queries` when the CLI named them only now (Codex). */
  settleWebSearch(id: string, results: string[], queries?: string[]): Promise<void>;
  /**
   * Private Flux text the run read (#1065, C-30), as `keptPrivateText` keeps it: its brief when it starts, and each Flux tool result. A web
   * address that carries a fragment of it is refused.
   */
  addPrivateText(runId: string, kept: KeptPrivateText): Promise<void>;
  /** All the private text the run has kept so far (#1143): its answer's addresses are checked against it before the answer is stored. */
  privateTexts(runId: string): Promise<KeptPrivateText[]>;
  /** The task graph's lock (after the owner's, #921) for a run in a space; a run in a DM or a chat touches no task graph and holds nothing. */
  prepareTaskUse(projectId: string | null, conversationId: string | null, sources?: readonly { type: string; id: string }[]): Promise<{ mark(): Promise<void> }>;
  /** The AI setup of one of the owner's agents: the one named, else their first (Assistant). A deleted agent has none. */
  enablement(ownerUserId: string, options?: { lock?: boolean; agentId?: string; workspaceId?: string }): Promise<EnablementRecord | null>;
  agentBrief(agentId: string): Promise<AgentBrief | null>;
  /** The person's own time zone (their notification settings'; UTC when unset): a schedule they ask for runs in it, and their agents tell time in it (#1064). */
  personTimeZone(userId: string): Promise<string>;
  /**
   * The names a run's brief gives its place (#1064): the space's, the task a conversation of it discusses, and a DM's people. Rows only:
   * callers authorize the place first.
   */
  placeNames(place: { projectId: string | null; conversationId: string | null; dmId: string | null }): Promise<PlaceNames>;
  /** A task as a run on it is told it (#1064), with the space it is in; null when it is gone. Callers authorize the space first. */
  taskBrief(workId: string): Promise<(TaskFacts & { projectId: string }) | null>;
  /**
   * Today's use of an API key's one daily budget (#854), in the key's time zone: what everything on the key was charged,
   * and what work in progress or of unknown cost holds. `exceptRunId` leaves one run out. Null when the key is gone.
   */
  keySpend(connection: Pick<PersonalConnection, 'id' | 'dailyBudgetCents' | 'timeZone'>, exceptRunId?: string): Promise<KeySpend | null>;
  /** The project of a conversation, whoever may read it; callers must authorize before using it. */
  locateConversation(conversationId: string): Promise<{ workspaceId: string; projectId: string } | null>;
  runByClientId(ownerUserId: string, clientRunId: string): Promise<RunRecord | null>;
  /**
   * With `visibleToOwner`, as the owner's own screen reads it: a guest of the company finds none of their runs (they are kept, hidden and
   * refused until the person is a member again, C-50, #1059). The worker's and the system's lookups leave it off.
   */
  findRun(id: string, options?: { lock?: boolean; visibleToOwner?: boolean }): Promise<RunRecord | null>;
  /** Whether the owner is a guest of the company now: their keys and plan sign-in are kept, but the assistant's status and model list show none (C-50, #1059). */
  ownerIsGuest(ownerUserId: string): Promise<boolean>;
  /** Whether a workspace is an encrypted space, where AI is always off (F-030). */
  workspaceEncrypted(workspaceId: string): Promise<boolean>;
  /** The owner's working runs and queued requests that are not paused by a limit (AST-6 queue). */
  inFlightCount(ownerUserId: string): Promise<number>;
  /** How many changes this run made or left waiting: what a second try would repeat. */
  changeCount(runId: string): Promise<number>;
  /** A task's number and title and the space it is in, for the line that reports a run on it (#919); null when it is gone. */
  workLabel(workId: string): Promise<{ number: number; title: string; projectId: string; projectName: string } | null>;
  /** Another run of this owner holds the lane (reading or dispatching), or this background run would pass a queued owner request: it waits. */
  laneBusy(ownerUserId: string, exceptRunId: string): Promise<boolean>;
  /** The runtime has room for one more agent (#860). Held until the transaction ends, so two claims never take the last place. */
  roomForRuntimeRun(): Promise<boolean>;
  /** The run holding the owner's lane (reading or dispatching), if any: what a queued request waits behind. */
  workingOf(ownerUserId: string): Promise<RunRecord | null>;
  /**
   * Queued runs whose owner's lane is free and whose resume time (a run paused by a limit) has come, the owner's requests
   * first and then oldest first: the next starts when the one before it ends.
   */
  startableQueued(limit: number): Promise<string[]>;
  insertRun(run: NewRun): Promise<RunRecord>;
  updateRun(id: string, changes: RunChanges): Promise<RunRecord>;
  /**
   * Ends the owner's queued and reading runs with `status` at zero cost (the reservation is
   * released) and returns them. Dispatching runs are left to the commit recheck.
   */
  endUndispatched(ownerUserId: string, status: 'revoked', agentId?: string): Promise<RunRecord[]>;
  /**
   * Ends the owner's in-flight runs untouched for `olderThanSeconds` (a crashed worker): a queued
   * or reading run as `unavailable` at zero cost, a dispatching one as `provider_failed` with its
   * reservation kept as `unknown`. Returns the ended runs.
   */
  endStale(ownerUserId: string, olderThanSeconds: number): Promise<RunRecord[]>;
  /**
   * The same for every owner, at most `limit` runs, skipping rows another sweep holds: the
   * background sweep, so a run a crashed worker left behind ends without the owner's next invoke.
   */
  endStaleAny(olderThanSeconds: number, limit: number): Promise<RunRecord[]>;
  /** Ends working runs on the runtime that are not in `running` and are older than this, one bounded batch. */
  endLostRuntime(running: readonly string[], olderThanSeconds: number, limit: number): Promise<RunRecord[]>;
  /** Holds the owner's lane until the transaction ends, so two claims of one owner never pass the lane check together. */
  lockLane(ownerUserId: string): Promise<void>;
  /** Only the owner's own runs, newest first; `place` narrows them to one place (#842). */
  listOwnRuns(ownerUserId: string, page: PageWindow, place?: RunPlaceFilter): Promise<Paged<RunRecord>>;
  /** Display names of people keyed by id. */
  names(userIds: string[]): Promise<Map<string, string>>;
  /** The company's people whose first name, in lower case, is one of these (#1163); whether they read a space is asked separately. */
  namesakes(workspaceId: string, firstNames: string[]): Promise<{ id: string; name: string }[]>;
  messages(conversationId: string, limit: number): Promise<MessageSource[]>;
  /**
   * The latest `limit` calls of the place a run reads, oldest first: what a call line shows (F-041 point 6). The space's own conversation (no
   * conversation, no task) has the space's calls, a task or its discussion has the task's, and a thread has none. A run is told them as events
   * beside the messages, never as messages.
   */
  calls(projectId: string, place: { conversationId: string | null; workId: string | null }, limit: number): Promise<CallSource[]>;
  /** The latest `limit` messages written in a space's conversations, oldest first: what its main conversation says (#842). */
  spaceMessages(projectId: string, limit: number): Promise<MessageSource[]>;
  /**
   * The latest `limit` messages of a direct message, oldest first (#842). The line "used AI here" is not one. With `threadRootId` (#1016) only
   * that thread: its root and its replies, and nothing else of the DM.
   */
  dmMessages(dmId: string, limit: number, threadRootId?: string | null): Promise<MessageSource[]>;
  /** Whether a message is a root (not a reply, not the line "used AI here") of this direct message: the only thing a thread can hang on (#1016). */
  isDmThreadRoot(dmId: string, messageId: string): Promise<boolean>;
  /** What the owner and this agent said last in their private chat, oldest first: the earlier turns of a chat (#842). */
  chatTurns(agentId: string, beforeRunId: string, limit: number): Promise<{ prompt: string; answer: string }[]>;
  /**
   * The line both people of a DM see when AI is used in it: "Ada used AI here (Claude)" (#842, F-036 AG-4). `company` is the name
   * of the company that receives the conversation. It takes a place in the DM but is not a message to read: no notification, no
   * preview, no search hit. Idempotent per run.
   */
  postDmAiLine(dmId: string, workspaceId: string, authorId: string, runId: string, company: string): Promise<void>;
  /**
   * Posts a line the agent says on its own in its chat, about one of its runs (#842). Once per `key` for the agent: a second call returns the
   * first line. Null when the agent is gone. Posting is the only way a line gets into a chat.
   */
  postAgentChat(line: { agentId: string; runId: string | null; key: string; body: string; schedule?: AgentChatMessage['schedule'] }): Promise<{ message: AgentChatMessage; created: boolean } | null>;
  /** The lines an agent said in its chat, oldest first, the latest `limit`. */
  agentChatMessages(agentId: string, limit: number): Promise<AgentChatMessage[]>;
  /** For each of the owner's agents, how much of its chat they have not read, and when it last said something. */
  agentChatSummaries(ownerUserId: string): Promise<AgentChatSummary[]>;
  /** The owner has read the chat up to now. */
  readAgentChat(agentId: string): Promise<void>;
  /** When the owner last had this chat open (#1246); null when they never did. */
  agentChatReadAt(agentId: string): Promise<string | null>;
  /** Whether this DM exists, whoever may read it; callers must authorize before using it. */
  locateDm(dmId: string): Promise<{ workspaceId: string } | null>;
  openWork(projectId: string, limit: number): Promise<WorkSource[]>;
  thought(sketchId: string, thoughtId: string): Promise<ThoughtSource | null>;
  /**
   * Whether the agent's rights connection (F-027 AST-3) is live. Runs that hold a run token end `revoked` once it is revoked
   * (the agent was deleted); older isolated fake repositories may omit it.
   */
  assistantConnectionLive?(ownerUserId: string, agentId: string): Promise<boolean>;
  /** The "What it may do" of this agent of the owner (F-036 AG-3: each agent has its own); null when it is gone. */
  assistantMayDo?(ownerUserId: string, agentId: string): Promise<AgentMayDo | null>;
}

/** Adapter over the core access policy. It never reveals objects the principal cannot see. */
export interface PersonalRunAccess {
  /**
   * Throws NotFoundError when the project is invisible and ForbiddenError when `write` is not
   * allowed. Inside a commit pass `lock`, so a concurrent revocation waits or is seen.
   */
  requireProject(principal: Principal, action: 'read' | 'write', projectId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string; level: 'contributor' | 'manager' }>;
  /** Whether the principal may `read` or `write` the project now; never throws for invisible ones. */
  canUseProject(principal: Principal, action: 'read' | 'write', projectId: string, options?: { lock?: boolean }): Promise<boolean>;
  /** Throws NotFoundError unless the principal takes part in the direct message now (#842: `/ai` is written in it, so it needs `dm.write`). */
  requireDm(principal: Principal, dmId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string }>;
  canUseDm(principal: Principal, dmId: string, options?: { lock?: boolean }): Promise<boolean>;
  /** `agent.invoke`: only the person who owns the unrevoked agent. Throws the policy's 404/403. */
  requireInvoke(principal: Principal, agentId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string }>;
  canInvoke(principal: Principal, agentId: string, options?: { lock?: boolean }): Promise<boolean>;
  canReadSketch(principal: Principal, sketchId: string, options?: { lock?: boolean }): Promise<boolean>;
  /**
   * AG-10: the space's AI switch (`lock` holds it `FOR SHARE`). `requireSpaceAi` throws SPACE_AI_OFF unless
   * AI is on there and, given an item's admission `epoch`, still at it; it returns the epoch a new run records.
   */
  spaceAi(projectId: string, options?: { lock?: boolean }): Promise<{ state: 'allowed' | 'blocked'; epoch: number }>;
  requireSpaceAi(projectId: string, options?: { lock?: boolean; epoch?: number }): Promise<{ epoch: number }>;
}

/** Queues the dispatch job of a run in the unit of work. The payload is the run id only. */
export interface PersonalRunQueue {
  enqueue(runId: string): Promise<void>;
}

export type PersonalRunEventKind =
  /** Owner-only progress of one run; the object is the run (`assistant_run`). */
  | 'assistant_run.changed.v1'
  /** The line "used AI here" joined a direct message: its participants read it again (#842). */
  | 'dm.changed.v1';

/**
 * Records a versioned event in the unit of work (identifiers only, never content). `objectId` is
 * the project for `project.*` kinds and the run for `assistant_run.*` kinds; the access policy
 * derives each event's audience from it.
 */
export interface PersonalRunEventLog {
  record(principal: Principal, workspaceId: string, kind: PersonalRunEventKind, objectId: string, data: Record<string, unknown>): Promise<void>;
}

/** Prepares the schedule an owner's words to their agent asked for (AG-9 "Set up by asking"); off, never turned on by a run. */
export interface PersonalRunSchedules {
  prepare(ownerUserId: string, agentId: string, runId: string, request: { title?: string; text: string; schedule: unknown }):
    Promise<{ ok: true; title: string; words: string } | { ok: false; message: string }>;
}

export interface PersonalRunPorts {
  /** Where an owner's request can prepare a schedule; the API does not run the processor, so only the worker supplies it. */
  schedules?: PersonalRunSchedules;
  /** Production always supplies the assistant identity adapter; older isolated fake ports may omit it. */
  assistants?: AssistantIdentityPort;
  access: PersonalRunAccess;
  runs: PersonalRunRepository;
  queue: PersonalRunQueue;
  events: PersonalRunEventLog;
}

/** Runs `work` in one transaction; on an open transaction (an idempotency scope) it nests. */
export interface PersonalRunUnitOfWork {
  run<T>(work: (ports: PersonalRunPorts) => Promise<T>): Promise<T>;
}

/**
 * The owner's usable key connection (O-007 custody, #124). `keyRef` is an opaque handle only the
 * worker's provider adapter can turn into a key; core never sees key material. The provider, model,
 * base URL and price are the connection's own (F-020 PROV-1/PROV-3); `price` is null when unknown.
 */
export interface PersonalConnection {
  id: string;
  ownerUserId: string;
  status: 'active' | 'revoked';
  keyRef: string;
  /** The owner's label, e.g. "Work OpenRouter"; the group's name in the model picker. */
  name: string;
  provider: AiProviderKind;
  model: string;
  /** `openai_compatible` only; null for a named provider's fixed URL. */
  baseUrl: string | null;
  price: AiPrice | null;
  /**
   * `false` when the owner marked this model as unable to call tools (F-027 AST-8.3): it then
   * answers in one request and cannot change anything. Absent means not marked; Flux's own dated
   * table of known models without tool calling applies as well (`aiModelCallsTools`).
   */
  toolCalling?: boolean;
  /** When the owner added it: Connect AI's default is the connection made first (#854). */
  createdAt?: Date;
  /** The key's one daily budget and the time zone whose midnight starts its day (#854). */
  dailyBudgetCents: number;
  timeZone: string;
  /** What the key knows of its models (#1218): the provider's last list, its freshness, the owner's prices, the ones no longer offered. */
  models?: KeyModels;
}

/** An API key's models as its provider last listed them (CA-2, #1218). */
export interface KeyModels extends ApiKeyModels {
  /** When the list now kept was read; null before the first. */
  listedAt: Date | null;
  /** The last attempt, whatever its outcome: the key is listed again when this is over 6 hours old. */
  checkedAt: Date | null;
  status: 'listed' | 'key_refused' | 'unavailable' | 'refused' | null;
}

/**
 * Resolves a connection of `ownerUserId` only (F-020 PROV-1: an owner may keep several). With a
 * `connectionId` it returns exactly that one when the owner still has it, otherwise null; without
 * one, the owner's newest active connection. `list` returns every active one, oldest first.
 */
export interface PersonalConnectionLookup {
  resolve(ownerUserId: string, connectionId?: string): Promise<PersonalConnection | null>;
  list(ownerUserId: string): Promise<PersonalConnection[]>;
}

/**
 * A Flux tool as the model sees it, the same neutral definition for every wire format (F-027
 * AST-8). `inputSchema` is the tool's JSON Schema object; each adapter writes it in its provider's
 * tool-calling format (`input_schema`, `function.parameters`).
 */
export interface PersonalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One call the model asked for. `invalid` is set when the provider's arguments were not a JSON object: it is never executed. */
export interface PersonalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  invalid?: true;
}

/** What came back for one call. A refused or failed call is a result with `isError`, never a thrown error. */
export interface PersonalToolResult {
  callId: string;
  content: string;
  isError: boolean;
  /** Pictures the call returned (#1217, `flux_view_image`), sent to the model as image input; base64 of a PNG, JPEG, WebP or GIF. */
  images?: PersonalImage[];
}
/** A picture as image input of a request (#1217). */
export interface PersonalImage { mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }

/**
 * One round of the tool loop: what the model said and asked for, and what came back. `replay` is
 * the provider's own assistant message exactly as it answered (opaque to core): an adapter echoes
 * it unchanged so provider-private continuity data (reasoning or thought signatures) survives.
 */
export interface PersonalTurn {
  text: string;
  /** None, with a `replay`, for a turn the provider paused (#1116): the next request is that answer sent back, with no results after it. */
  calls: PersonalToolCall[];
  results: PersonalToolResult[];
  replay?: unknown;
}

/**
 * One bounded request (O-008 §3) to the owner's connection, the same for every provider (F-020):
 * no hosted tools but the provider's own web search (`webSearch`, #954), no automatic retries. The adapter of `connection.provider`
 * translates it. Without `tools` it is exactly the single request of O-008 (no tools on the wire).
 * With `tools` (F-027 AST-8) the same request is one turn of the worker's bounded tool loop:
 * `turns` carries the earlier turns, each with the results that came back, and every turn is still
 * one request that is bounded, billed and reconciled by itself.
 */
export interface PersonalComputeRequest {
  connection: { id: string; keyRef: string; provider: AiProviderKind; baseUrl: string | null };
  model: string;
  maxTokens: number;
  effort: 'low';
  system: string;
  input: string;
  tools?: readonly PersonalTool[];
  turns?: readonly PersonalTurn[];
  /**
   * Offer the provider's own built-in web search (#954, C-29): only with `tools`, only while the operator's switch is on, and only
   * to a provider that has one (`AI_PROVIDERS[kind].searchesWeb`); as many searches as the question needs (#1113). Absent: no search.
   */
  webSearch?: true;
}

/**
 * `reportedCostMicros`: the provider's own cost of the response, when it reports one (PROV-3 source 1). `webSearches`: how many
 * searches of the provider's built-in web search the response made (#954), each charged `WEB_SEARCH_MICROS`.
 */
export interface PersonalComputeUsage { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null; webSearches?: number }

/**
 * What a response of the provider's built-in web search brought (#954, C-30), read from the provider's structured answer and never
 * from the model's text: the queries it searched, the addresses the search returned and the addresses the answer cites. Each address
 * is normalized (no fragment) and at most `ADDRESS_MAX` long. The queries, and the cited addresses that a search of the run returned,
 * are listed under its answer (C-30).
 */
export interface WebSearchFound { queries: string[]; results: string[]; cited: string[] }

export type PersonalComputeResult =
  | {
    kind: 'completed'; text: string; usage: PersonalComputeUsage;
    /**
     * `tool_use`: the model stopped to call tools. Only then are `toolCalls` set, and never from a
     * response that was cut off or refused (a partial call is not executable). `pause_turn` (#1116): the provider paused a long turn
     * of its own web search; `replay` is the paused answer, which the next request sends back to go on. It is never a run's answer.
     */
    stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'tool_use' | 'pause_turn';
    toolCalls?: PersonalToolCall[];
    /** The provider's own assistant message for the next request, with `toolCalls`; see {@link PersonalTurn}. */
    replay?: unknown;
    /** Set when the response searched the web or cites a search result (#954). */
    webSearch?: WebSearchFound;
  }
  /**
   * `billed: 'none'` when the provider documents no charge (e.g. 429, 5xx before work); else `unknown`. `searchRefused`: the provider
   * refused its own web search tool on this key or model (#954), with no charge; the tool loop sends the request again without it.
   */
  | { kind: 'failed'; reason: 'rate_limited' | 'overloaded' | 'provider_error' | 'timeout' | 'aborted' | 'no_credits'; billed: 'none' | 'unknown'; searchRefused?: true };

/**
 * The provider behind the `agent-runtime` port: the adapters of `@flux/agent-runtime`, selected by
 * the connection's provider kind; `enabled` is the instance operator's switch (O-008 §6).
 */
export interface PersonalCompute {
  readonly enabled: boolean;
  /** The operator's `FLUX_WEB_READS` (#954, C-29): whether a run with tools is offered its provider's built-in web search. */
  readonly webSearch?: boolean;
  /**
   * An optional provider token count of the request's input (free, not a dispatch). It may only
   * raise the conservative Flux estimate that bounds every provider's input (PROV-3).
   */
  countInputTokens?(request: PersonalComputeRequest): Promise<number | null>;
  /**
   * Sends the request once. `signal` aborts it as best effort when the owner stops the run. `onText` (#1248): the answer's words as the
   * provider streams them, in order; an adapter that cannot stream calls it never, and the result is the same either way.
   */
  dispatch(request: PersonalComputeRequest, signal: AbortSignal, onText?: (delta: string) => void): Promise<PersonalComputeResult>;
}

/**
 * The asker's live view of a run (#1248): what the agent writes, as it writes it, and the Flux tool it uses now. Delivered to the run's
 * owner over the live stream only, never stored; best effort (a failure only leaves their view to the final answer).
 */
export type RunLivePiece = { runId: string; turn: number; at: number; text: string } | { runId: string; step: string };
export interface RunLiveText {
  send(ownerUserId: string, piece: RunLivePiece): Promise<void>;
}

/**
 * The provider refused its own web search tool when Flux counted a request's tokens (#954; the review of #1073): the request is counted
 * again without the search. Thrown by `PersonalCompute.countInputTokens` only for a request that offered the search.
 */
export class WebSearchRefusedError extends Error {
  constructor() {
    super('The provider refused its web search tool');
    this.name = 'WebSearchRefusedError';
  }
}

/**
 * The tools of one run and the way to call them (F-027 AST-8). The worker's production
 * implementation is an MCP client of the API's `/mcp` route with the run's token, so the owner's
 * switches, caps, place checks and change log stay in one place (A6 with A2); core only knows this
 * seam. `tools` is exactly what the run may use; a call outside it is never sent.
 */
export interface PersonalToolSession {
  readonly tools: readonly PersonalTool[];
  /** Fresh owner-authorized external facts provided by the run-token issuer, already bounded/redacted. */
  readonly context?: string;
  /** Runs one call as the run's agent. A refusal or failure is a result with `isError`, not an exception. */
  call(call: PersonalToolCall, signal: AbortSignal): Promise<{ content: string; isError: boolean; images?: PersonalImage[] }>;
  /** Ends the session (the run token); called once, whatever the outcome. */
  close(): Promise<void>;
}

/**
 * Opens the tool session of one run, or null when the run has no tools (every switch off, or no
 * run token). Throwing ends the run `unavailable` at zero cost: nothing falls back to a run
 * without the tools it was started with.
 */
export type PersonalToolHost = (run: RunRecord, connection: PersonalConnection) => Promise<PersonalToolSession | null>;

/**
 * A run's MCP token (F-027 A2), minted by the API (Flux's authorization server) for the worker. `issue`
 * returns null when the run is no longer in flight or the owner's assistant connection is unavailable;
 * `close` ends the token whatever the run does next. The token is never stored.
 */
export interface PersonalRunTokenIssuer {
  issue(runId: string): Promise<PersonalRunTokenGrant | null>;
  close(runId: string): Promise<void>;
}

/** The owner's own Claude Code in the agent runtime, as the server sees it (F-022 AIM-3). */
export interface PersonalRuntimeStanding {
  state: 'off' | 'signed_out' | 'sign_in_again' | 'signed_in';
  payer: AgentRuntimePayer | null;
  accountLabel: string | null;
  /** The CLI this standing describes (Codex since F-022 T6, #281); null when the runtime is off. */
  client?: PersonalRuntimeClient | null;
  /** When the owner signed in, while signed in: Connect AI's default is the connection made first (#854). */
  signedInAt?: Date | null;
  /** The models the signed-in CLI last listed for the account (#1332); null until the first reading. */
  models?: PlanModels | null;
}
export type PersonalRuntimeClient = 'claude_code' | 'codex';
export interface PersonalRuntimeAvailability {
  /** One CLI's standing, or without `client` the owner's most recently signed-in available CLI. */
  standing(ownerUserId: string, client?: PersonalRuntimeClient): Promise<PersonalRuntimeStanding>;
}

/** Where one owner's runtime run goes: their bound slot and binding directory, never chosen by a request. */
export interface PersonalRuntimeTarget { slot: string; bindingId: string; client?: PersonalRuntimeClient }

/**
 * What the runtime reported while a run ran (the CLI's JSONL reduced by the slot to closed shapes). `search` and `found` (#1065): Claude
 * Code started its `n`th web search, and what its result entries held.
 */
export type PersonalRuntimeEvent =
  | { kind: 'init'; tools: string[]; mcpServers: { name: string; status: string }[] }
  | { kind: 'tool'; name: string }
  | { kind: 'search'; n: number; query: string }
  | { kind: 'found'; n: number; results: string[]; queries?: string[] }
  /** The CLI's words as it streams them (#1248): `turn` is its message; Codex hands each message whole. */
  | { kind: 'text'; turn: number; text: string };

/** How a runtime run ended. `unavailable`: the slot refused or could not be reached before the CLI ran. */
export type PersonalRuntimeEnd =
  | { kind: 'answer'; text: string; turns: number }
  | { kind: 'ended'; reason: AssistantRunEndReason | 'stopped' | 'unavailable' | 'input_too_large'; planResetsAt?: Date | null };

export interface PersonalRuntimeRunRequest {
  runId: string;
  prompt: string;
  runToken: string;
  tools: string[];
  caps: { maxTurns: number; wallClockSeconds: number; idleSeconds: number; maxAnswerBytes: number };
  /** The model the run was sent with (F-027 AST-11), for the CLI's own model option; absent: the CLI's default. */
  model?: string;
  /** The CLI keeps its own web search (#1065, C-29): Claude Code's `WebSearch`, Codex's web search on OpenAI's cached index. */
  webSearch?: true;
}

/**
 * The worker's side of the `runtime` transport for runs (F-022 AIM-3 "Run"): it asks runtime-manager to run
 * the owner's CLI in their slot. `enabled` is the operator's switch. Every call happens outside a transaction.
 */
export interface PersonalRuntime {
  readonly enabled: boolean;
  /** The operator's web switch (`FLUX_WEB_READS`, C-29): a run on the owner's CLI searches with the CLI's own web search (#1065). */
  readonly webSearch?: boolean;
  /** The owner's signed-in CLI of the run (Claude Code or Codex), or why it cannot run now. */
  target(ownerUserId: string, client?: PersonalRuntimeClient): Promise<{ ok: true; target: PersonalRuntimeTarget } | { ok: false; reason: 'off' | 'sign_in_again' | 'unavailable' }>;
  run(target: PersonalRuntimeTarget, request: PersonalRuntimeRunRequest, onEvent: (event: PersonalRuntimeEvent) => void): Promise<PersonalRuntimeEnd>;
  /** SIGINT, then SIGTERM, then kill (F-022 "Stop"). `stopping`: the slot acknowledged the stop. */
  stop(target: PersonalRuntimeTarget, runId: string): Promise<'stopping' | 'not_running' | 'failed'>;
}
