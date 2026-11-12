import type { Page, PageQuery } from './access.js';
import type { AiProviderKind } from './ai-providers.js';
import type { AgentRuntimePayer } from './agent-runtime.js';
import type { MessageFile } from './files.js';

/**
 * Owner-invoked personal assistant runs (issue #68; Connect AI, #854).
 *
 * A person's agents (#857) each run on a model from one of their Connect AI connections (a Claude plan, a ChatGPT
 * plan or an API key); their first agent, Assistant, is invoked in a project conversation. There is no consent screen per use and no Flux limit;
 * an API key keeps its one daily budget. Invocation, stop and retry resolve the owner, agent and connection only from
 * the authenticated session; no id in a request body selects them. The answer is shown to that conversation's audience
 * as "<owner>'s assistant". Cost, the connection and hidden sources are never shown to anyone but the owner.
 */
export const PERSONAL_ASSISTANT_PATH = '/api/v1/personal-assistant';
export const ASSISTANT_RUNS_PATH = '/api/v1/assistant-runs';
export const assistantRunPath = (runId: string) => `${ASSISTANT_RUNS_PATH}/${runId}`;
export const assistantRunStopPath = (runId: string) => `${assistantRunPath(runId)}/stop`;
export const assistantRunRetryPath = (runId: string) => `${assistantRunPath(runId)}/retry`;
export const conversationAssistantRunsPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-runs`;
/** `/ai` in a space's main conversation (#842): the stream of its roots has no conversation of its own. */
export const projectAssistantRunsPath = (projectId: string) => `/api/v1/projects/${projectId}/assistant-runs`;
/** `/ai` in a direct message (#842). */
export const dmAssistantRunsPath = (dmId: string) => `/api/v1/dms/${dmId}/assistant-runs`;
/** `/ai` in a thread of a direct message (#1016): `rootId` is the thread's root message. */
export const dmThreadAssistantRunsPath = (dmId: string, rootId: string) => `/api/v1/dms/${dmId}/threads/${rootId}/assistant-runs`;
/** A message to one of the caller's own agents in its private chat (#842). */
export const agentAssistantRunsPath = (agentId: string) => `/api/v1/my-agents/${agentId}/assistant-runs`;
/**
 * The status of one of the caller's own agents (C-3): its own connection and model, so its private chat waits only when *its* connection
 * was removed, never because another agent's was. The same shape as `GET /api/v1/personal-assistant`; anyone else's agent is 404.
 */
export const agentAssistantStatusPath = (agentId: string) => `/api/v1/my-agents/${agentId}/status`;
/** Show everyone (#842): the answer is posted as its asker's message, "Ada · via Assistant". */
export const assistantRunShowPath = (runId: string) => `${assistantRunPath(runId)}/show`;
/** Dismiss (#842): the asker puts an answer, or the line of a run that ended, away. */
export const assistantRunDismissPath = (runId: string) => `${assistantRunPath(runId)}/dismiss`;
export const conversationAssistantAnswersPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-answers`;

/**
 * Where a run belongs (#842, F-036 AG-4). `space`: a space's conversation, a thread or a task's thread (`conversationId`), or the
 * space's main conversation (`null`); its audience is the people who read the space. `dm`: a direct message, or one of its threads
 * (`threadRootId`, the thread's root message; `null` for the DM's main line); its audience is the DM's participants either way.
 * `chat`: the private chat with one of the owner's agents; its audience is the owner alone.
 */
export type AssistantPlace =
  | { kind: 'space'; projectId: string; conversationId: string | null }
  | { kind: 'dm'; dmId: string; threadRootId: string | null }
  | { kind: 'chat'; agentId: string };

/**
 * The private chats with a person's agents (#842, F-036 AG-4, AG-7). A chat is the owner's messages and the agent's answers (runs, listed by
 * `GET /assistant-runs?chatAgentId=`) and the agent's own lines: the reports of its work, each about one run (`AgentChatMessage`). Only the
 * agent's owner reads any of it. What the owner has not read yet is `AgentChatSummary.unread`; opening the chat reads it.
 */
export const AGENT_CHATS_PATH = '/api/v1/agent-chats';
export const agentChatMessagesPath = (agentId: string) => `${AGENT_CHATS_PATH}/${agentId}/messages`;
export const agentChatReadPath = (agentId: string) => `${AGENT_CHATS_PATH}/${agentId}/read`;
/**
 * One line an agent said on its own in its chat, about the run it reports (#919): the change line "Done: #4 …", with the agent's own words
 * of that run and the task it was about above it. `changes` is how many of the run's changes stand now, as its Undo would take them back
 * (not the agent's own line in the task's thread): the line offers Undo while it is above zero. `undone` is how many were taken back.
 * `words` and `task` are null when the line has none, or when the person can no longer read the task's space.
 * A schedule's result is a line of its own (`schedule`, #858): `body` is the result, or what happened when it did not come ("Sign in to Claude again");
 * `runId` is null when the firing could not start, so there is no run behind it.
 */
export interface AgentChatMessage {
  id: string; agentId: string; runId: string | null; body: string; createdAt: string;
  changes: number; undone: number;
  words: string | null;
  task: { id: string; number: number; title: string; projectId: string; projectName: string } | null;
  /** The schedule that said it: its name and when it runs ("Every weekday at 9:00"); `failed` when there is no result to show. Null for any other line. */
  schedule: { title: string; words: string; failed: boolean } | null;
}
/**
 * `GET /api/v1/agent-chats/:agentId/messages`: the agent's lines, and `readAt`, when the owner last had this chat open (#1246): what the agent said
 * after it is new to them, where the chat's "New" divider goes. Null when they never opened it: all the agent said is new.
 */
export interface AgentChatLines { items: AgentChatMessage[]; readAt: string | null }
/** `GET /api/v1/agent-chats`: for each of the caller's agents, what they have not read in its chat (answers and reports) and when it last said something. */
export interface AgentChatSummary { agentId: string; unread: number; lastAt: string | null }

/**
 * Stream event of a run's progress (O-008 §4 "Progress"): `objectType` `assistant_run`, the run
 * id as `objectId`. Its audience is the run's owner alone; the client refetches
 * `GET /api/v1/assistant-runs/:id`. Nobody else learns that a run exists until its answer is
 * committed (`project.assistant_answer_committed.v1`, the project's audience).
 */
export const ASSISTANT_RUN_CHANGED_EVENT = 'assistant_run.changed.v1';
/** Statuses of a run that is still working; the owner's working line shows Stop for these. */
export const ASSISTANT_RUN_IN_FLIGHT = ['queued', 'reading', 'dispatching'] as const;

/**
 * The engine of the owner's assistant (F-022 mode (a)): `server`, the worker calls the provider with the
 * owner's own API key (F-020), or `runtime`, the owner's own signed-in Claude Code in their runtime slot
 * (AIM-3). Both reach Flux only through the MCP route with a run token (F-027 AST-8).
 */
export const ASSISTANT_ENGINES = ['server', 'runtime'] as const;
export type AssistantEngine = (typeof ASSISTANT_ENGINES)[number];

/**
 * Technical safety bounds of a run on a plan (#843, model-providers CA-3). Flux sets no limits of its own: no runs a day,
 * no five-minute clock, no step or change count. These bounds only stop a run that has gone wrong (a CLI that never
 * ends or loops); nobody meets them in normal use. They are listed in the operator guide.
 */
export const RUNTIME_RUN_LIMITS = {
  maxTurns: 200,
  wallClockSeconds: 3600,
  idleSeconds: 600,
  maxAnswerBytes: 64 * 1024,
} as const;

/**
 * A run's MCP token (F-022 "Agent connection and permissions", F-027 A2): it lives as long as the run's clock and a little
 * more, and the MCP route bounds what tools return to it, per call and per run. Both are safety bounds (#843).
 */
export const RUN_TOKEN_LIMITS = {
  lifetimeSeconds: RUNTIME_RUN_LIMITS.wallClockSeconds + 300,
  resultBytesPerCall: 256 * 1024,
  resultBytesPerRun: 8 * 1024 * 1024,
} as const;

/**
 * Why a run ended without an answer, when its status alone does not say (F-022 T5: each end has its own
 * state). `sign_in_again`: the CLI's login expired or was signed out at the vendor. `plan_limit`: the CLI
 * reported a plan limit (nothing falls back to an API key). `wall_clock` and `no_event`: the run's two
 * timeouts. `crashed`: the CLI exited without a result. `answer_too_large`: the answer passed its bound.
 * `mcp_results_too_large`: a tool result or the run's results passed the route's bound. `local_tool`: the
 * CLI showed a tool or MCP server other than the run's exact Flux tools. `slot_busy`: the slot's serial
 * lane was taken (a sign-in, a status check or another run). `unknown`: the CLI's stream broke; whether it
 * changed anything is not known and it is never rerun. `max_turns`: the safety bound on steps. `refused`: the model
 * refused the request. `model_unavailable`: the vendor did not accept the model the owner chose (F-027 AST-11);
 * nothing was changed and no other model was tried. `ai_off` (F-029, #614): AI is turned off in the run's
 * workspace; nothing was posted. `budget` (#854): the API key's one daily budget is used; the agent pauses until the
 * next day. `credits` (CA-3): the provider's API credits ran out; nothing switches to another connection. `no_room` (#860): not
 * an end but a wait: the request stays queued until the server has room for another agent.
 */
export const ASSISTANT_RUN_END_REASONS = [
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large',
  'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits', 'no_room',
] as const;
export type AssistantRunEndReason = (typeof ASSISTANT_RUN_END_REASONS)[number];

/**
 * INTERNAL, worker to API only (F-027 A2): the API is the authorization server, so it signs a run's MCP
 * token. The worker proves it holds the run with a one-time nonce whose hash it stored on the run row; the
 * token is minted once, for an in-flight run only, and is never stored.
 */
export const personalRunTokenPath = (runId: string) => `/api/internal/v1/personal-runs/${runId}/run-token`;
export interface PersonalRunTokenRequest { nonce: string }
export interface PersonalRunTokenGrant {
  token: string;
  /** The run's exact Flux tools, from the owner's switches when the token was minted (F-027 AST-4). */
  tools: string[];
  expiresAt: string;
  /** Owner-authorized, freshly read external facts for this run (G-1); data, never instructions. */
  context?: string;
}

/**
 * The bounds of one request of a run on an API key (F-020 PROV-3, #843). Flux prices each request at the model's price
 * before sending it, so the API key's daily budget holds; these token bounds make that price knowable. They are technical
 * bounds, not limits on the owner's use: the only limit is the key's daily budget. `effort` applies where the wire format
 * has it (Anthropic Messages).
 */
export const PERSONAL_RUN_LIMITS = {
  effort: 'low',
  maxInputTokens: 32_000,
  /**
   * The input bound of one request of a run with tools (#484): the Flux tool definitions travel with every request and its
   * earlier turns, so a tool run may send twice the single-request bound.
   */
  maxToolInputTokens: 64_000,
  maxOutputTokens: 4_000,
  /** The safety bound on requests ("steps") of one run with a tool loop, the same as on a plan. */
  maxTurns: RUNTIME_RUN_LIMITS.maxTurns,
  prompt: 4_000,
} as const;

/**
 * The room a request that is offered the provider's built-in web search has in its input for what its searches brought (#954, #1113):
 * the provider counts the results as input in the request that searched and, on Anthropic, in every later request of the run, which
 * carries them back. Searches are not counted or limited (founder direction 2026-11-09), so this is one room for the results a request
 * carries, not a room for a number of searches. Flux's assumption, to be checked against real keys: OpenAI bills its mini models a
 * fixed block of 8,000 input tokens a search (developers.openai.com pricing, read 2026-11-08), and no vendor states a size for the others.
 */
export const WEB_SEARCH_INPUT_TOKENS = 50_000;

/**
 * The input bound of one request of a run: the larger one when the run can call tools (#484), and with the room for the results of
 * its searches when the run is offered its provider's web search (#954). It bounds what Flux sends; what a request that searched
 * reports as input is bounded by the money the run has left, not by this (a search's results are input the provider adds on its own).
 */
export const personalRunMaxInputTokens = (tools: boolean, webSearch = false): number =>
  (tools ? PERSONAL_RUN_LIMITS.maxToolInputTokens + (webSearch ? WEB_SEARCH_INPUT_TOKENS : 0) : PERSONAL_RUN_LIMITS.maxInputTokens);

/**
 * One of a person's Connect AI connections (#854): their Claude plan (`claude_plan`), their ChatGPT plan (`chatgpt_plan`)
 * or one of their API keys (the key connection's id).
 */
export type AiConnectionRef = 'claude_plan' | 'chatgpt_plan' | (string & {});

/** The AI setup of one of the owner's agents: the model it runs on and the connection that model belongs to. */
export interface PersonalRunEnablement {
  ownerUserId: string;
  agentId: string;
  workspaceId: string;
  /** The connection the agent's model belongs to. */
  connection: AiConnectionRef;
  /** Where runs go: the owner's API key (`server`) or their own Claude Code or Codex in the runtime. */
  engine: AssistantEngine;
  /** The agent's model, an id from its connection's list (F-027 AST-11). */
  model: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** `capped`: the assistant's API key used its daily budget; it resumes the next day (#854). */
export type PersonalAssistantState = 'not_enabled' | 'ready' | 'capped' | 'unavailable';
/** `price_unknown`: the API key's model has no known price, so its daily budget cannot hold (PROV-3). */
export type PersonalAssistantUnavailableReason = 'no_connection' | 'connection_changed' | 'provider_off' | 'price_unknown'
  /** A runtime assistant: the operator switched sign-in off, or the owner must sign in again. */
  | 'runtime_off' | 'runtime_sign_in';

/** `GET /api/v1/personal-assistant`: only ever the caller's own state: that of their first agent (Assistant, which answers `/ai`) and of this Flux. */
export interface PersonalAssistantStatus {
  state: PersonalAssistantState;
  unavailableReason: PersonalAssistantUnavailableReason | null;
  enablement: PersonalRunEnablement | null;
  /**
   * What this instance can do for the caller now, so the UI can say why an assistant cannot run
   * instead of pretending: the operator's provider switch (O-008 §6) and whether the caller has
   * a usable key connection of their own (O-007/#124). Never another person's.
   */
  setup: {
    provider: 'on' | 'off'; connection: 'active' | 'none';
    /**
     * The caller's own Claude Code or Codex in the agent runtime (F-022 AIM-3): `off` when the operator has not
     * enabled it; otherwise whether the caller is signed in. `payer` comes from the CLI's reported
     * `authMethod` only (never shown as zero).
     */
    runtime: {
      state: 'off' | 'signed_out' | 'sign_in_again' | 'signed_in'; payer: AgentRuntimePayer | null; accountLabel: string | null;
      /** Which of the owner's CLIs this is; null when off. */
      client?: 'claude_code' | 'codex' | null;
    };
  };
  /**
   * On an API key: today's use of that key's one daily budget, by everything that runs on it, in the key's time zone.
   * Null on a plan (its limits are the provider's) and without an assistant.
   */
  today: { chargedMicros: number; reservedMicros: number; budgetCents: number; resetsAt: string } | null;
}

/**
 * What started a run. `scheduled` is started by Flux's own tick for the owner's schedules (F-027 A8); only the first three
 * can be asked for through the API.
 */
export type AssistantRunKind = 'ask' | 'summarize' | 'map_thought' | 'scheduled' | 'task' | 'task_answer';

/** A map thought on a project sketch of the conversation's project. */
export interface AssistantRunTarget {
  type: 'thought';
  sketchId: string;
  thoughtId: string;
}

/**
 * `POST /api/v1/conversations/:conversationId/assistant-runs` (202). `ownerId`, `connectionId`
 * and `agentId` never select anything: naming anything but the caller's own is 403 before any
 * reservation. Reusing `clientRunId` returns the existing run (200) and never charges twice.
 */
export interface InvokeAssistantRunCommand {
  clientRunId: string;
  kind: AssistantRunKind;
  prompt: string;
  target?: AssistantRunTarget;
  /** An earlier committed run of the caller in the same conversation; its answer is passed as input. */
  continuesRunId?: string;
  ownerId?: string;
  connectionId?: string;
  agentId?: string;
}

/** `POST /api/v1/assistant-runs/:runId/retry` (202): a new run by the owner with the same request. */
export interface RetryAssistantRunCommand {
  clientRunId: string;
}

export type AssistantRunStatus =
  | 'queued' | 'reading' | 'dispatching'
  | 'completed' | 'truncated'
  | 'stopped' | 'denied' | 'paused' | 'revoked' | 'cap_reached' | 'unavailable'
  | 'input_too_large' | 'provider_failed';

/**
 * `reserved`: the most the run can cost is held against the API key's daily budget. `released`: nothing was dispatched,
 * cost zero. `observed`: the provider reported usage. `unknown`: the response was lost; the reservation stays counted.
 */
export type AssistantRunCostState = 'reserved' | 'released' | 'observed' | 'unknown';

/** The owner's view of their run. Nobody else can read it (404). */
export interface AssistantRun {
  id: string;
  clientRunId: string;
  workspaceId: string;
  /** The run's place (#842): a space (with its conversation unless it is the main one), a direct message, or neither: a private chat. */
  projectId: string | null;
  conversationId: string | null;
  dmId: string | null;
  /** The root message of the DM thread the run belongs to (#1016); null for the DM's main line and for every other place. */
  dmThreadRootId: string | null;
  /** The agent that answers. */
  agentId: string;
  kind: AssistantRunKind;
  prompt: string;
  target: AssistantRunTarget | null;
  continuesRunId: string | null;
  retryOfRunId: string | null;
  status: AssistantRunStatus;
  /** Where a recheck refused the run: access, grant, pause, budget or connection. */
  stoppedAtStage: 'before_read' | 'before_dispatch' | 'before_commit' | null;
  stopRequested: boolean;
  /** The runtime confirmed the stop (F-022 "Stop": requested and acknowledged are separate). */
  stopAcknowledged: boolean;
  engine: AssistantEngine;
  /** The model this run was sent with, fixed when it was sent (F-027 AST-11); the engine's own label when none was chosen. */
  model: string;
  /** A `runtime` run's CLI (F-022 T6 #281), for its own words ("ChatGPT" or "Claude"); null otherwise. Optional for older servers. */
  runtimeClient?: 'claude_code' | 'codex' | null;
  /** Why it ended without an answer, when the status alone does not say; null otherwise. */
  endReason: AssistantRunEndReason | null;
  /** With `plan_limit`: when the CLI said the plan resets, if it said so. */
  planLimitResetsAt: string | null;
  /**
   * A request paused by its connection's limit (a plan's limit or the API key's daily budget) waits as a queued run that
   * starts by itself at this time (#854): "Claude limit reached, resumes at 14:00". Null otherwise.
   */
  resumesAt?: string | null;
  cost: {
    state: AssistantRunCostState;
    reservedMicros: number;
    chargedMicros: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  /** Set once the answer was committed to the conversation. */
  answer: AssistantAnswer | null;
  /**
   * What started it: the owner's own request, or the owner's stored schedule (F-027 AST-6). A background
   * run carries the short name the owner gave it. Optional for older servers.
   */
  authority?: AssistantRunAuthority;
  backgroundLabel?: string | null;
  /** While queued: the run it waits behind, so the line can say "Next: …" or "Finishing your daily check first". Optional for older servers. */
  behind?: AssistantRunBehind | null;
  /**
   * A run that ended without an answer and asked for web addresses: every address the server sent a request to, in Flux's words ("Read on the web:",
   * "Requested, not read:"), for its end line (#953). Absent otherwise; an answer lists them itself.
   */
  webSources?: string;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  /** The answer was posted with Show everyone, or put away with Dismiss (#842); null while it is the asker's alone to see. */
  shownAt?: string | null;
  dismissedAt?: string | null;
  /** The pictures its agent attached to its answer in its private chat (#1217, C-59): its owner's alone. Absent elsewhere. */
  pictures?: MessageFile[];
}

export type AssistantRunAuthority = 'owner_request' | 'owner_schedule';
/** The working run a queued request waits behind (AST-6 "Queue"): another request, or a background run by name. */
export interface AssistantRunBehind { runId: string; authority: AssistantRunAuthority; label: string | null }

export type AssistantSourceRef =
  | { type: 'message'; id: string; revision: number }
  | { type: 'work'; id: string; revision: number }
  | { type: 'thought'; id: string; sketchId: string; revision: number };

/** A committed answer as the conversation's audience sees it. No cost, budget or connection. */
export interface AssistantAnswer {
  runId: string;
  conversationId: string | null;
  projectId: string | null;
  /** A task run's answer is the project's; the answer to `/ai`, to a chat and of a schedule is its owner's alone until Show everyone (#842, #1104). */
  audience: { kind: 'project'; projectId: string } | { kind: 'owner' };
  /** The agent's name for the asker's own answer ("Assistant"); "Jo's assistant" for one posted in a conversation. */
  assistant: { ownerUserId: string; label: string };
  askedBy: { id: string; name: string };
  request: { kind: AssistantRunKind; prompt: string };
  body: string;
  /** Stopped at the output limit: shown as truncated; the owner can continue it. */
  truncated: boolean;
  provenance: { provider: AiProviderKind; model: string };
  /** Only supplied project-audience sources the answer cites. */
  sources: AssistantSourceRef[];
  committedAt: string;
}

export type AssistantAnswerPage = Page<AssistantAnswer>;

/**
 * `GET /api/v1/assistant-runs?…` lists only the caller's runs; at most one of these narrows them to one place (#842):
 * a conversation, a space's main conversation, a direct message or an agent's private chat.
 */
export interface ListOwnRunsQuery extends PageQuery {
  conversationId?: string; spaceId?: string; chatAgentId?: string;
  /** A DM's main line; with `dmThreadRootId`, one of its threads (#1016). */
  dmId?: string; dmThreadRootId?: string;
}

/** `POST /api/v1/assistant-runs/:runId/show` (#842): the message the answer became. */
export interface ShowAnswerResult { run: AssistantRun; messageId: string }
