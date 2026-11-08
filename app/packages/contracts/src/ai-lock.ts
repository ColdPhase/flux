/**
 * The AI switch of a space (F-037, AG-10; it replaces the workspace AI lock of F-029, #614): how every HTTP route of the AI
 * modules behaves while AI is off in a space. The API refuses to start when one of their routes is missing here, so this
 * list is complete by construction; `tests/app/space-ai-routes.test.ts` calls every gated route.
 *
 * - `gated`: answered `403 SPACE_AI_OFF` before the handler when the space of the named object has AI off and the
 *   caller can open that space (others get the route's own answer, so nothing about other spaces leaks).
 *   `onlyWhen` narrows it to a body that turns something on.
 * - `use_case`: the space is not in the request; the use case checks or filters it.
 * - `exempt`: no AI read or action, belongs to a person rather than a space, or only reduces or shows one's own history.
 */
import { TASK_TAKING_PATH, taskAgentPath, taskAgentRetryPath, taskAgentStopPath, taskPeoplePath } from './agent-tasks.js';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_CONSOLE_RESUME_PATH,
  AGENT_RUNTIME_NOTICE_PATH, AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH } from './agent-runtime.js';

export type AiScopeKind = 'project' | 'conversation' | 'work' | 'run' | 'assistant_proposal'
  | 'assistant_change' | 'agent_question'
  | 'assistant_job';

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
const ACCOUNT = 'Account-level, no space content; the work it would start is gated where it runs';
const PERSON = 'Belongs to a person, not to a space; what an agent does in a space is checked in that space (AG-10)';

/** Keyed by `METHOD path` exactly as the route is registered. */
export const AI_HTTP_ROUTES: Readonly<Record<string, AiRouteRule>> = {
  // External agent connections and consent (F-016, #52/#152).
  'GET /api/v1/agent-connections': exempt('The owner\'s own connections, so they can see and remove them'),
  // "What it may do" (F-036 #855): a setting of the agent itself, which belongs to a person.
  'PATCH /api/v1/agent-connections/:connectionId': exempt(PERSON),
  'DELETE /api/v1/agent-connections/:connectionId': exempt(REDUCES),
  'GET /api/v1/projects/:projectId/agent-proposals': gated('params', 'projectId', 'project'),
  'GET /api/v1/projects/:projectId/agents': gated('params', 'projectId', 'project'),
  'GET /api/v1/working-agents': useCase('The person\'s working agents across spaces; work in a space with AI off is left out'),
  'GET /api/v1/projects/:projectId/agent-stops': gated('params', 'projectId', 'project'),
  'POST /api/v1/projects/:projectId/agent-stops': exempt(REDUCES),
  // #160 AC-5: pausing only narrows; resuming lets the agent claim again, so it needs the space's AI on.
  'POST /api/v1/projects/:projectId/agent-pauses': gated('params', 'projectId', 'project', { body: 'paused', equals: false }),
  'GET /api/v1/projects/:projectId/agent-questions': gated('params', 'projectId', 'project'),
  'POST /api/v1/agent-questions/:questionId/answer': gated('params', 'questionId', 'agent_question'),
  // An owner's API keys (Connect AI, #854).
  'POST /api/v1/background-compute-connections': exempt(ACCOUNT),
  'GET /api/v1/background-compute-connections': exempt(ACCOUNT),
  'PATCH /api/v1/background-compute-connections/:connectionId': exempt(ACCOUNT),
  'POST /api/v1/ai-model-lists': exempt(ACCOUNT),
  'DELETE /api/v1/background-compute-connections/:connectionId': exempt(REDUCES),
  // People's agents take tasks (#856, AG-5): the setting is a person's; the state shows what an agent did; Retry starts AI work again.
  [`GET ${TASK_TAKING_PATH}`]: exempt(PERSON),
  [`PUT ${TASK_TAKING_PATH}`]: exempt(PERSON),
  [`GET ${taskAgentPath(':workId')}`]: exempt('Shows what an agent did on a task; no AI read or action'),
  [`GET ${taskPeoplePath(':workId')}`]: exempt('Names the people of a task and their agents; no AI read or action'),
  [`POST ${taskAgentStopPath(':workId')}`]: exempt(REDUCES),
  [`POST ${taskAgentRetryPath(':workId')}`]: gated('params', 'workId', 'work'),
  // The assistant (F-027).
  'POST /api/v1/workspaces/:workspaceId/assistant-operator-requests': exempt(PERSON),
  'GET /api/v1/conversations/:conversationId/assistant-changes': gated('params', 'conversationId', 'conversation'),
  'GET /api/v1/assistant-runs/:runId/changes': exempt(`${OWN_HISTORY}: one run's changes, from which the owner can Undo`),
  'POST /api/v1/assistant-runs/:runId/changes/apply': gated('params', 'runId', 'run'),
  'POST /api/v1/assistant-runs/:runId/changes/skip': exempt(REDUCES),
  'POST /api/v1/assistant-runs/:runId/changes/undo': exempt('A human compensating write as the owner; the owner can always reverse AI output'),
  'POST /api/v1/assistant-changes/:changeId/apply': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/skip': exempt(REDUCES),
  'POST /api/v1/assistant-changes/:changeId/edit': gated('params', 'changeId', 'assistant_change'),
  'POST /api/v1/assistant-changes/:changeId/undo': exempt('A human compensating write as the owner; the owner can always reverse AI output'),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules': exempt(PERSON),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules': gated('body', 'projectId', 'project'),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/preview': exempt(PERSON),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/background-note': exempt(PERSON),
  'PATCH /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId': gated('params', 'jobId', 'assistant_job', { body: 'enabled', equals: true }),
  'DELETE /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId': exempt(REDUCES),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/restore': gated('params', 'jobId', 'assistant_job'),
  'POST /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/run': gated('params', 'jobId', 'assistant_job'),
  'GET /api/v1/workspaces/:workspaceId/assistants/:ownerUserId/schedules/:jobId/history': exempt(PERSON),
  'GET /api/v1/personal-assistant': exempt('Account-wide status of the owner\'s own assistant; no AI read or action'),
  'GET /api/v1/personal-assistant/model': exempt(ACCOUNT),
  'PUT /api/v1/personal-assistant/model': exempt(ACCOUNT),
  // A person's agents (F-036 AG-1, #857): their own setup, instructions and memory. What an agent does in a space is checked in that space (AG-10).
  'GET /api/v1/my-agents': exempt(PERSON),
  'POST /api/v1/my-agents': exempt(PERSON),
  'GET /api/v1/my-agents/:agentId': exempt(PERSON),
  'PATCH /api/v1/my-agents/:agentId': exempt(PERSON),
  'DELETE /api/v1/my-agents/:agentId': exempt(REDUCES),
  'GET /api/v1/my-agents/:agentId/memory': exempt(PERSON),
  'POST /api/v1/my-agents/:agentId/memory': exempt(PERSON),
  'PATCH /api/v1/my-agents/:agentId/memory/:itemId': exempt(PERSON),
  'DELETE /api/v1/my-agents/:agentId/memory/:itemId': exempt(REDUCES),
  'POST /api/v1/conversations/:conversationId/assistant-runs': gated('params', 'conversationId', 'conversation'),
  // `/ai` in the space's main conversation, in a direct message and a message to one's own agent (#842). A DM and a chat are in no space.
  'GET /api/v1/agent-chats': exempt(OWN_HISTORY),
  'GET /api/v1/agent-chats/:agentId/messages': exempt(OWN_HISTORY),
  'POST /api/v1/agent-chats/:agentId/read': exempt(OWN_HISTORY),
  'POST /api/v1/projects/:projectId/assistant-runs': gated('params', 'projectId', 'project'),
  'POST /api/v1/dms/:dmId/assistant-runs': useCase('A direct message is in no space, so it has no switch; its participants and the agent\'s standing are checked'),
  'POST /api/v1/dms/:dmId/threads/:rootId/assistant-runs': useCase('A thread of a direct message is in no space, so it has no switch; the DM\'s participants and the agent\'s standing are checked'),
  'POST /api/v1/my-agents/:agentId/assistant-runs': useCase('A private chat is in no space; whatever its agent reads is checked and gated in that space, call by call'),
  'POST /api/v1/assistant-runs/:runId/show': gated('params', 'runId', 'run'),
  'POST /api/v1/assistant-runs/:runId/dismiss': exempt(REDUCES),
  'GET /api/v1/conversations/:conversationId/assistant-answers': exempt('Committed answers a conversation posted (a schedule\'s) are conversation history'),
  'GET /api/v1/assistant-runs': exempt(OWN_HISTORY),
  'GET /api/v1/assistant-runs/:runId': exempt(OWN_HISTORY),
  'POST /api/v1/assistant-runs/:runId/stop': exempt(REDUCES),
  'POST /api/v1/assistant-runs/:runId/retry': gated('params', 'runId', 'run'),
  'GET /api/v1/projects/:projectId/assistant-proposals': gated('params', 'projectId', 'project'),
  'GET /api/v1/assistant-proposals/:proposalId': gated('params', 'proposalId', 'assistant_proposal'),
  'POST /api/v1/assistant-proposals/:proposalId/accept': gated('params', 'proposalId', 'assistant_proposal'),
  'POST /api/v1/assistant-proposals/:proposalId/dismiss': gated('params', 'proposalId', 'assistant_proposal'),
  // The owner's runtime slot (F-022): account-level; runs on it are gated per space in the worker and in each tool call.
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
  'GET /api/v1/work/:workId/agent-thread': exempt('Existing agent-thread messages stay readable as history'),
  'POST /api/v1/work/:workId/agent-thread': gated('params', 'workId', 'work'),
};

/**
 * Routes outside the AI modules that the contract's enforcement tables name (F-029). They are not wrapped by `aiRoutes`, so
 * `tests/app/space-ai-queues.test.ts` scans their source files (`AI_NAMED_ROUTE_MODULES`) and fails on a route that is
 * missing here or listed but gone. `use_case` routes check or filter in their use case; `exempt` ones are not AI work.
 */
export const AI_NAMED_ROUTE_MODULES = [
  'apps/server/src/identity/oauth-context.ts', 'apps/server/src/identity/auth.ts', 'apps/server/src/access/agents.ts', 'apps/server/src/access/projects.ts',
  'apps/server/src/needs-you/routes.ts', 'apps/server/src/notifications/routes.ts', 'apps/server/src/push/index.ts',
] as const;

const SETTINGS = 'Account or company settings; no AI read or action';
const ROSTER = 'Human management of identities; the names are metadata for people, shown to members whatever the AI state';
export const AI_ADJACENT_ROUTES: Readonly<Record<string, AiRouteRule>> = {
  'GET /api/v1/agent-oauth/consent-context': exempt(PERSON),
  'GET /api/v1/workspaces/:workspaceId/agents': exempt(ROSTER),
  'POST /api/v1/workspaces/:workspaceId/agents': exempt(PERSON),
  'DELETE /api/v1/agents/:agentId': exempt(REDUCES),
  'GET /api/v1/workspaces/:workspaceId/projects': exempt(SETTINGS),
  'POST /api/v1/workspaces/:workspaceId/projects': exempt(SETTINGS),
  'POST /api/v1/projects/:projectId/views': exempt('Adding a view is project layout; the Agents view is hidden by the interface and its routes are gated'),
  'GET /api/v1/projects/:projectId': exempt(SETTINGS),
  'PATCH /api/v1/projects/:projectId': exempt(SETTINGS),
  'DELETE /api/v1/projects/:projectId': exempt(`${REDUCES}: erasing a space ends its AI work with everything else`),
  'POST /api/v1/projects/:projectId/leave': exempt(SETTINGS),
  'PUT /api/v1/projects/:projectId/ai-policy': exempt('The switch itself: a space admin or company admin turns AI off or on, and turning it off sweeps the space\'s AI work'),
  'GET /api/v1/projects/:projectId/grants': exempt('Managers see and can remove the grants of agents'),
  'GET /api/v1/projects/:projectId/people': useCase('Agents are omitted by the principal layer (each candidate is evaluated)'),
  'POST /api/v1/projects/:projectId/grants': exempt('A standing grant for an agent is configuration; the agent is denied while AI is off and works again afterwards'),
  'DELETE /api/v1/projects/:projectId/grants/:grantId': exempt(REDUCES),
  'GET /api/v1/needs-you': useCase('Assistant changes and notes of a space with AI off are left out, and so are AI-origin notifications'),
  'POST /api/v1/needs-you/:key': useCase('An item of a space with AI off is not in the queue, so resolving it answers 404'),
  'DELETE /api/v1/needs-you/:key': exempt('Restores an item the person put aside; shows nothing the list does not'),
  'GET /api/v1/notification-preferences': exempt(SETTINGS),
  'PATCH /api/v1/notification-preferences': exempt(SETTINGS),
  'PUT /api/v1/notification-preferences/mutes': exempt(SETTINGS),
  'POST /api/v1/notification-addresses': exempt(SETTINGS),
  'PATCH /api/v1/notification-addresses/:addressId': exempt(SETTINGS),
  'DELETE /api/v1/notification-addresses/:addressId': exempt(SETTINGS),
  'POST /api/v1/notification-addresses/:addressId/resend': exempt(SETTINGS),
  'POST /api/v1/notification-addresses/verify': exempt(SETTINGS),
  'POST /api/v1/notifications/unsubscribe': exempt(SETTINGS),
  'GET /api/v1/push/public-key': exempt(SETTINGS),
  'GET /api/v1/push/subscriptions': exempt(SETTINGS),
  'POST /api/v1/push/subscriptions': exempt(SETTINGS),
  'DELETE /api/v1/push/subscriptions/:id': exempt(REDUCES),
  'GET /api/v1/inbox': useCase('AI-origin notifications of a space with AI off are left out of the list and the unread count (ai_origin)'),
  'POST /api/v1/inbox/read-all': exempt('Marks the person\'s own notifications read'),
  'GET /api/v1/inbox/:id': useCase('An AI-origin notification of a space with AI off answers 404'),
  'POST /api/v1/inbox/:id/read': useCase('An AI-origin notification of a space with AI off answers 404'),
};

/**
 * Every queue, trigger and table of AI work (F-029), checked by `tests/app/space-ai-queues.test.ts` against the
 * worker's actual `boss.work`/`boss.schedule` registrations, `pg_trigger` and the schema: anything unlisted fails.
 * `ai` jobs re-check the space's switch (and an item's epoch) at every step; `notAi` jobs touch no AI work, except that
 * push and e-mail sends skip AI-origin notifications of a space whose AI is off.
 */
export const AI_WORK_QUEUES = {
  /** Identifiers of the job-name constants the worker registers. */
  ai: ['PERSONAL_RUN_JOB', 'ASSISTANT_TICK_JOB', 'SPACE_AI_SWEEP_JOB'],
  /** Jobs that start no AI work, each with the reason (the test fails on a job that is in neither list). */
  notAi: {
    IDEMPOTENCY_CLEANUP_JOB: 'idempotency.cleanup.v1 deletes expired idempotency keys; it reads no workspace content',
    NOTIFICATION_EMAIL_JOB: 'notification.email.v1 sends a person\'s e-mail; it skips an AI-origin notification of a space whose AI is off (ai_origin)',
    PUSH_SEND_JOB: 'push.send sends a person\'s push; it skips an AI-origin notification of a space whose AI is off (ai_origin)',
    SAMPLE_JOB: 'sample.process is the platform example job: it processes a sample row and touches no workspace content',
    SEARCH_CHANGES_CLEANUP_JOB: 'search-changes.cleanup.v1 deletes the change log (document keys and times) of encrypted workspaces after 24 hours; it opens no content',
    WORKSPACE_ENCRYPTION_RESUME_JOB: 'workspace-encryption.resume.v1 replays a sealed workspace\'s waiting work after an unlock; AI is always off there (F-030)',
  } as Readonly<Record<string, string>>,
  /** Tables whose rows wait for AI work: each has `ai_epoch` (no default) and the `ai_work_admission` trigger. */
  tables: ['personal_runs', 'cowork_units'],
  /** Functions that insert AI work from inside a person's own write; each checks the policy first and never raises. */
  captureFunctions: [] as readonly string[],
} as const;
