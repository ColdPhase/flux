/**
 * The workspace AI lock (F-029, #614; docs/product/workspace-ai-lock.md): how every HTTP route of the AI modules
 * behaves while AI is off in a workspace. The API refuses to start when one of their routes is missing here, so this
 * list is complete by construction; `tests/app/workspace-ai-routes.test.ts` calls every gated route.
 *
 * - `gated`: answered `403 WORKSPACE_AI_BLOCKED` before the handler when the named object's workspace has AI off and
 *   the caller is a member there (others get the route's own answer, so nothing about other workspaces leaks).
 *   `onlyWhen` narrows it to a body that turns something on.
 * - `use_case`: the workspace is not in the request; the use case checks or filters it.
 * - `exempt`: no AI read or action, or only reducing or showing one's own history.
 */
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_CONSOLE_RESUME_PATH,
  AGENT_RUNTIME_NOTICE_PATH, AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH } from './agent-runtime.js';

export type AiScopeKind = 'workspace' | 'project' | 'conversation' | 'work' | 'agent' | 'connection' | 'run' | 'assistant_proposal'
  | 'assistant_change' | 'agent_question' | 'comparison_rule' | 'comparison_proposal' | 'comparison_outcome' | 'assistant_join'
  | 'assistant_job' | 'notification';

export type AiRouteRule =
  | { gate: 'gated'; from: 'params' | 'body'; key: string; kind: AiScopeKind; onlyWhen?: { body: string; equals: unknown } }
  | { gate: 'use_case'; reason: string }
  | { gate: 'exempt'; reason: string };

const gated = (from: 'params' | 'body', key: string, kind: AiScopeKind, onlyWhen?: { body: string; equals: unknown }): AiRouteRule =>
  ({ gate: 'gated', from, key, kind, ...(onlyWhen ? { onlyWhen } : {}) });
const exempt = (reason: string): AiRouteRule => ({ gate: 'exempt', reason });
const useCase = (reason: string): AiRouteRule => ({ gate: 'use_case', reason });

const OWN_HISTORY = 'The owner\'s own history; no AI read or action';
const REDUCES = 'Only stops, removes or narrows; never starts AI work';
const ACCOUNT = 'Account-level, no workspace content; the work it would start is gated where it runs';

/** Keyed by `METHOD path` exactly as the route is registered. */
export const AI_HTTP_ROUTES: Readonly<Record<string, AiRouteRule>> = {
  // External agent connections and consent (F-016, #52/#152).
  'POST /api/v1/agent-connections': gated('body', 'agentId', 'agent'),
  'GET /api/v1/agent-connections': exempt('The owner\'s own connections, so they can see and remove them'),
  'POST /api/v1/agent-connections/:connectionId/action-grants': gated('params', 'connectionId', 'connection'),
  'GET /api/v1/agent-connections/:connectionId/action-grants': exempt('The owner\'s own grants, so they can see and remove them'),
  'DELETE /api/v1/agent-connections/:connectionId/action-grants/:grantId': exempt(REDUCES),
  'PATCH /api/v1/agent-connections/:connectionId/action-grants/:grantId': gated('params', 'connectionId', 'connection'),
  'DELETE /api/v1/agent-connections/:connectionId': exempt(REDUCES),
  'POST /api/v1/agent-connections/:connectionId/select-for-oauth': gated('params', 'connectionId', 'connection'),
  'GET /api/v1/projects/:projectId/agent-proposals': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/agents': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/agent-policy': gated('params', 'projectId', 'project'),
  'PUT /api/v1/projects/:projectId/agent-policy': gated('params', 'projectId', 'project'),
  'GET /api/v1/working-agents': useCase('The person\'s working agents across workspaces; agents of a workspace with AI off are left out'),
  'GET /api/v1/projects/:projectId/agent-stops': gated('params', 'projectId', 'project'),
  'POST /api/v1/projects/:projectId/agent-stops': exempt(REDUCES),
  // #160 AC-5: pausing only narrows; resuming lets the agent claim again, so it needs the workspace's AI on.
  'POST /api/v1/projects/:projectId/agent-pauses': gated('params', 'projectId', 'project', { body: 'paused', equals: false }),
  'GET /api/v1/projects/:projectId/agent-questions': gated('params', 'projectId', 'project'),
  'POST /api/v1/agent-questions/:questionId/answer': gated('params', 'questionId', 'agent_question'),
  'GET /api/v1/agent-connections/:connectionId/permissions': gated('params', 'connectionId', 'connection'),
  'PATCH /api/v1/agent-connections/:connectionId/permissions': gated('params', 'connectionId', 'connection'),
  // Background comparisons (O-007, #58).
  'GET /api/v1/background-comparisons/runtime': exempt(ACCOUNT),
  'POST /api/v1/background-compute-connections': exempt(ACCOUNT),
  'GET /api/v1/background-compute-connections': exempt(ACCOUNT),
  'GET /api/v1/background-compute-connections/current': exempt(ACCOUNT),
  'PATCH /api/v1/background-compute-connections/:connectionId': exempt(ACCOUNT),
  'POST /api/v1/ai-model-lists': exempt(ACCOUNT),
  'DELETE /api/v1/background-compute-connections/:connectionId': exempt(REDUCES),
  'POST /api/v1/projects/:projectId/proactive-comparison-rules': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/proactive-comparison-rules': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/proactive-comparison-proposals': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/proactive-comparison-outcomes': gated('params', 'projectId', 'project'),
  'PATCH /api/v1/proactive-comparison-outcomes/:outcomeId': exempt('Dismiss only; never starts AI work'),
  'GET /api/v1/background-compute-usage': exempt(ACCOUNT),
  'PATCH /api/v1/proactive-comparison-proposals/:proposalId': gated('params', 'proposalId', 'comparison_proposal'),
  'POST /api/v1/proactive-comparison-proposals/:proposalId/use': gated('params', 'proposalId', 'comparison_proposal'),
  'PATCH /api/v1/proactive-comparison-rules/:ruleId': gated('params', 'ruleId', 'comparison_rule', { body: 'status', equals: 'enabled' }),
  // The assistant (F-027).
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/settings': gated('params', 'workspaceId', 'workspace'),
  'PATCH /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/settings': gated('params', 'workspaceId', 'workspace'),
  'POST /api/v1/projects/:projectId/assistant-join-requests': gated('params', 'projectId', 'project'),
  'POST /api/v1/projects/:projectId/assistant-join-requests/:requestId/allow': gated('params', 'projectId', 'project'),
  'POST /api/v1/projects/:projectId/assistant-join-requests/:requestId/decline': exempt(REDUCES),
  'POST /api/v1/workspaces/:workspaceId/assistant-operator-requests': gated('params', 'workspaceId', 'workspace'),
  'GET /api/v1/conversations/:conversationId/assistant-changes': gated('params', 'conversationId', 'conversation'),
  'GET /api/v1/assistant-changes': exempt(`${OWN_HISTORY}: the change log, from which the owner can Undo`),
  'GET /api/v1/conversations/:conversationId/assistant-activity': gated('params', 'conversationId', 'conversation'),
  'GET /api/v1/assistant-runs/:runId/changes': exempt(`${OWN_HISTORY}: one run's changes, from which the owner can Undo`),
  'POST /api/v1/assistant-runs/:runId/changes/apply': gated('params', 'runId', 'run'),
  'POST /api/v1/assistant-runs/:runId/changes/not-now': gated('params', 'runId', 'run'),
  'POST /api/v1/assistant-runs/:runId/changes/undo': exempt('A human compensating write as the owner; the owner can always reverse AI output'),
  'POST /api/v1/assistant-runs/:runId/changes/inbox': gated('params', 'runId', 'run'),
  'POST /api/v1/assistant-changes/:changeId/apply': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/not-now': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/undo': exempt('A human compensating write as the owner; the owner can always reverse AI output'),
  'POST /api/v1/assistant-changes/:changeId/dismiss': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/accept': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/send': gated('params', 'changeId', 'assistant_change'),
  'GET /api/v1/workspaces/:workspace/people/:owner/assistant/when': gated('params', 'workspace', 'workspace'),
  'GET /api/v1/workspaces/:workspace/people/:owner/assistant/when/history': gated('params', 'workspace', 'workspace'),
  'POST /api/v1/workspaces/:workspace/people/:owner/assistant/when': gated('params', 'workspace', 'workspace'),
  'PUT /api/v1/workspaces/:workspace/people/:owner/assistant/when/:id': gated('params', 'workspace', 'workspace', { body: 'enabled', equals: true }),
  'GET /api/v1/inbox/:id/assistant-draft': gated('params', 'id', 'notification'),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules': gated('params', 'workspaceId', 'workspace'),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules': gated('params', 'workspaceId', 'workspace'),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/preview': gated('params', 'workspaceId', 'workspace'),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/background-note': gated('params', 'workspaceId', 'workspace'),
  'PATCH /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId': gated('params', 'workspaceId', 'workspace', { body: 'enabled', equals: true }),
  'DELETE /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId': exempt(REDUCES),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/restore': gated('params', 'workspaceId', 'workspace'),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/run': gated('params', 'workspaceId', 'workspace'),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/history': gated('params', 'workspaceId', 'workspace'),
  'GET /api/v1/assistant/morning-summary': exempt(ACCOUNT),
  'PUT /api/v1/assistant/morning-summary': exempt(`${ACCOUNT}: the worker reads no workspace whose AI is off`),
  'GET /api/v1/personal-assistant': exempt('Account-wide status of the owner\'s own assistant; no AI read or action'),
  'POST /api/v1/personal-assistant': gated('body', 'agentId', 'agent'),
  'PATCH /api/v1/personal-assistant': exempt('Caps and time zone only'),
  'GET /api/v1/personal-assistant/model': exempt(ACCOUNT),
  'PUT /api/v1/personal-assistant/model': exempt(ACCOUNT),
  'PUT /api/v1/personal-assistant/agents': gated('body', 'agentId', 'agent'),
  'POST /api/v1/personal-assistant/pause': exempt(REDUCES),
  'POST /api/v1/personal-assistant/resume': exempt(`${ACCOUNT}: runs stay gated per workspace`),
  'DELETE /api/v1/personal-assistant': exempt(REDUCES),
  'POST /api/v1/conversations/:conversationId/assistant-runs': gated('params', 'conversationId', 'conversation'),
  'GET /api/v1/conversations/:conversationId/assistant-answers': exempt('Committed answers are conversation history'),
  'GET /api/v1/assistant-runs': exempt(OWN_HISTORY),
  'GET /api/v1/assistant-runs/:runId': exempt(OWN_HISTORY),
  'POST /api/v1/assistant-runs/:runId/stop': exempt(REDUCES),
  'POST /api/v1/assistant-runs/:runId/retry': gated('params', 'runId', 'run'),
  'GET /api/v1/projects/:projectId/assistant-proposals': gated('params', 'projectId', 'project'),
  'GET /api/v1/assistant-proposals/:proposalId': gated('params', 'proposalId', 'assistant_proposal'),
  'POST /api/v1/assistant-proposals/:proposalId/accept': gated('params', 'proposalId', 'assistant_proposal'),
  'POST /api/v1/assistant-proposals/:proposalId/dismiss': gated('params', 'proposalId', 'assistant_proposal'),
  // The owner's runtime slot (F-022): account-level; runs on it are gated in the worker and at /mcp.
  [`GET ${AGENT_RUNTIME_PATH}`]: exempt(ACCOUNT),
  [`POST ${AGENT_RUNTIME_BINDING_PATH}`]: exempt(ACCOUNT),
  [`DELETE ${AGENT_RUNTIME_BINDING_PATH}`]: exempt(REDUCES),
  [`POST ${AGENT_RUNTIME_CONSOLE_PATH}`]: exempt(ACCOUNT),
  [`POST ${AGENT_RUNTIME_CONSOLE_RESUME_PATH}`]: exempt(ACCOUNT),
  [`GET ${AGENT_RUNTIME_CONSOLE_PATH}`]: exempt(ACCOUNT),
  [`POST ${AGENT_RUNTIME_SIGN_OUT_PATH}`]: exempt(REDUCES),
  [`POST ${AGENT_RUNTIME_CHECK_PATH}`]: exempt(ACCOUNT),
  [`POST ${AGENT_RUNTIME_NOTICE_PATH}`]: exempt(ACCOUNT),
  // Co-work (#153) and agent threads.
  'GET /api/v1/work/:workId/coordination': gated('params', 'workId', 'work'),
  'GET /api/v1/work/:workId/coordination/requests/:requestId/packet': gated('params', 'workId', 'work'),
  'POST /api/v1/work/:workId/coordination/requests/:requestId/cancel': exempt(REDUCES),
  'GET /api/v1/projects/:projectId/review-policy': gated('params', 'projectId', 'project'),
  'PUT /api/v1/projects/:projectId/review-policy': gated('params', 'projectId', 'project'),
  'GET /api/v1/work/:workId/agent-thread': exempt('Existing agent-thread messages stay readable as history'),
  'POST /api/v1/work/:workId/agent-thread': gated('params', 'workId', 'work'),
};

/**
 * Routes outside the AI modules that the contract's enforcement tables name (F-029). They are not wrapped by `aiRoutes`, so
 * `tests/app/workspace-ai-queues.test.ts` scans their source files (`AI_NAMED_ROUTE_MODULES`) and fails on a route that is
 * missing here or listed but gone. `use_case` routes check or filter in their use case; `exempt` ones are not AI work.
 */
export const AI_NAMED_ROUTE_MODULES = [
  'apps/server/src/identity/oauth-context.ts', 'apps/server/src/identity/auth.ts', 'apps/server/src/access/agents.ts', 'apps/server/src/access/projects.ts',
  'apps/server/src/needs-you/routes.ts', 'apps/server/src/notifications/routes.ts', 'apps/server/src/push/index.ts',
] as const;

const SETTINGS = 'Account or workspace settings; no AI read or action';
const ROSTER = 'Human management of identities; the names are metadata for people, shown to members whatever the AI state';
export const AI_ADJACENT_ROUTES: Readonly<Record<string, AiRouteRule>> = {
  'GET /api/v1/agent-oauth/consent-context': useCase('Omits the connections and workspaces whose AI is off'),
  'GET /api/v1/agent-oauth/held-connection': useCase('Answers 403 WORKSPACE_AI_BLOCKED for a held connection of a blocked workspace'),
  'GET /api/v1/workspaces/:workspaceId/agents': exempt(ROSTER),
  'POST /api/v1/workspaces/:workspaceId/agents': useCase('createAgent requires AI to be on in its transaction (403 WORKSPACE_AI_BLOCKED)'),
  'DELETE /api/v1/agents/:agentId': exempt(REDUCES),
  'GET /api/v1/workspaces/:workspaceId/projects': exempt(SETTINGS),
  'POST /api/v1/workspaces/:workspaceId/projects': exempt(SETTINGS),
  'POST /api/v1/projects/:projectId/views': exempt('Adding a view is project layout; the Agents view is hidden by the interface and its routes are gated'),
  'GET /api/v1/projects/:projectId': exempt(SETTINGS),
  'GET /api/v1/projects/:projectId/grants': exempt('Managers see and can remove the grants of agents'),
  'GET /api/v1/projects/:projectId/people': useCase('Agents are omitted by the principal layer (each candidate is evaluated)'),
  'POST /api/v1/projects/:projectId/grants': exempt('A standing grant for an agent is configuration; the agent is denied while AI is off and works again afterwards'),
  'DELETE /api/v1/projects/:projectId/grants/:grantId': exempt(REDUCES),
  'GET /api/v1/needs-you': useCase('Assistant changes and notes of a blocked workspace are left out, and so are AI-origin notifications'),
  'POST /api/v1/needs-you/:key': useCase('An item of a blocked workspace is not in the queue, so resolving it answers 404'),
  'DELETE /api/v1/needs-you/:key': exempt('Restores an item the person put aside; shows nothing the list does not'),
  'GET /api/v1/notification-preferences': exempt(SETTINGS),
  'PATCH /api/v1/notification-preferences': exempt(SETTINGS),
  'PUT /api/v1/notification-preferences/mutes': exempt(SETTINGS),
  'POST /api/v1/notification-address': exempt(SETTINGS),
  'DELETE /api/v1/notification-address': exempt(SETTINGS),
  'POST /api/v1/notification-address/resend': exempt(SETTINGS),
  'POST /api/v1/notification-address/verify': exempt(SETTINGS),
  'POST /api/v1/notifications/unsubscribe': exempt(SETTINGS),
  'GET /api/v1/push/public-key': exempt(SETTINGS),
  'GET /api/v1/push/subscriptions': exempt(SETTINGS),
  'POST /api/v1/push/subscriptions': exempt(SETTINGS),
  'DELETE /api/v1/push/subscriptions/:id': exempt(REDUCES),
  'GET /api/v1/inbox': useCase('AI-origin notifications of a blocked workspace are left out of the list and the unread count (ai_origin)'),
  'POST /api/v1/inbox/read-all': exempt('Marks the person\'s own notifications read'),
  'GET /api/v1/inbox/:id': useCase('An AI-origin notification of a blocked workspace answers 404'),
  'POST /api/v1/inbox/:id/read': useCase('An AI-origin notification of a blocked workspace answers 404'),
};

/**
 * Every queue, trigger and table of AI work (F-029), checked by `tests/app/workspace-ai-queues.test.ts` against the
 * worker's actual `boss.work`/`boss.schedule` registrations, `pg_trigger` and the schema: anything unlisted fails.
 * `ai` jobs re-check the workspace policy (and an item's epoch) at every step; `notAi` jobs touch no AI work, except that
 * push and e-mail sends skip AI-origin notifications of a workspace whose AI is off.
 */
export const AI_WORK_QUEUES = {
  /** Identifiers of the job-name constants the worker registers. */
  ai: ['PERSONAL_RUN_JOB', 'ASSISTANT_TICK_JOB', 'MORNING_SUMMARY_JOB', 'COMPARISON_TICK_JOB', 'COMPARISON_RECOVERY_JOB', 'WORKSPACE_AI_SWEEP_JOB'],
  /** Jobs that start no AI work, each with the reason (the test fails on a job that is in neither list). */
  notAi: {
    DRAFT_SUMMARY_JOB: 'draft.summarize.v1 is a deterministic word count with no model request; it rechecks its requester, and an agent requester is denied by the principal layer while AI is off',
    IDEMPOTENCY_CLEANUP_JOB: 'idempotency.cleanup.v1 deletes expired idempotency keys; it reads no workspace content',
    NOTIFICATION_EMAIL_JOB: 'notification.email.v1 sends a person\'s e-mail; it skips an AI-origin notification of a workspace whose AI is off (ai_origin)',
    PUSH_SEND_JOB: 'push.send sends a person\'s push; it skips an AI-origin notification of a workspace whose AI is off (ai_origin)',
    SAMPLE_JOB: 'sample.process is the platform example job: it processes a sample row and touches no workspace content',
    SEARCH_CHANGES_CLEANUP_JOB: 'search-changes.cleanup.v1 deletes the change log (document keys and times) of encrypted workspaces after 24 hours; it opens no content',
    WORKSPACE_ENCRYPTION_RESUME_JOB: 'workspace-encryption.resume.v1 replays a sealed workspace\'s waiting work after an unlock; AI is always off there (F-030)',
  } as Readonly<Record<string, string>>,
  /** Tables whose rows wait for AI work: each has `ai_epoch` (no default) and the `ai_work_admission` trigger. */
  tables: ['personal_runs', 'proactive_comparison_outbox', 'assistant_reaction_events', 'cowork_requests', 'cowork_units', 'agent_runtime_sessions'],
  /** Functions that insert AI work from inside a person's own write; each checks the policy first and never raises. */
  captureFunctions: ['assistant_capture_reaction'],
} as const;
