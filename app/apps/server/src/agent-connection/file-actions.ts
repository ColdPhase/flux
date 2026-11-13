import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { AGENT_OPERATION_CLASSES, FILE_LIMITS, PICTURE_RUN_KINDS, type AgentJsonValue, type StagedFile } from '@flux/contracts';
import { DomainError, derivedUuid, type FileStorage, type FileUseCaseOptions } from '@flux/core';
import { assistantChangeRows, fileRows, schema, type Database, type DbExecutor } from '@flux/db';
import { fetchRunFile, type RunFileError } from '@flux/runtime-protocol';
import { fileUseCases } from '../files/adapters.js';
import { actionAnnotations as annotations, actionInput, nativeActionExecutor } from './action-execution.js';
import { isAssistantText, type AssistantCall } from './assistant-changes.js';
import { agentConnectionInTransaction } from './context.js';
import type { AgentToolRegistry, ToolCall } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/**
 * `flux_attach_file` (#1437, RT-5, AG-8): an agent attaches a file to its answer to `/ai` in a space, as its asker would attach one. A run on
 * the owner's Claude Code or Codex names a file it made in its scratch (`path`): the server asks the run's supervisor for it through
 * runtime-manager, which reads it as the run's person with Flux's sandbox reader (only a regular file inside that run's scratch, while the run
 * lasts). Any run, an API-key run included, can instead give a text file's `content`. Either way the bytes go through the asker's own upload
 * path (`stage`): the same types, size limits and checks as a person's upload (magic bytes, a picture decoded and written again, #1343, a
 * video's own limit, C-61), the same preview, staged for the asker alone until their Show everyone posts it with the answer.
 *
 * Attaching is a change of AG-3, through the same executor as every other: under "Do it and tell me" it is made at once, with its line and
 * Undo; under "Ask me first" the file is staged now (the scratch is gone once the run ends) and joins the answer only on the owner's
 * Approve; under "Only read" it is refused. Never in an encrypted space. A refusal comes back as plain words.
 */

interface FileServices { storage: FileStorage; options: FileUseCaseOptions; manager: { url: string; secret: string } | null }
let services: FileServices | null = null;
export function configureAgentFiles(next: FileServices | null) { services = next; }

const OPERATION = 'answer.file.attach' as const;
const refusal = (words: string) => ({ content: [{ type: 'text' as const, text: `Not attached. ${words}` }], isError: true as const });
class Refused extends Error {}
const refuse = (words: string): never => { throw new Refused(words); };

/** What the supervisor's answer means, for the agent. */
const READ_WORDS: Record<RunFileError, string> = {
  file_missing: 'There is no such file in your working directory.',
  file_not_regular: 'That is not a file (a folder or a link cannot be attached).',
  file_too_large: 'The file is larger than a file in Flux may be.',
  not_running: 'Your run has ended, so its files are gone.',
  no_sandbox: 'This server runs no tools of your own, so give the file\'s content instead.',
  invalid_request: 'The path is not one Flux can read.',
  unauthorized: 'The runtime could not be reached.', unknown_slot: 'The runtime could not be reached.', no_binding: 'The runtime could not be reached.',
  binding_unsafe: 'The runtime could not be reached.', internal: 'The file could not be read.', unreachable: 'The runtime could not be reached.',
  timeout: 'The file took too long to arrive.', protocol: 'The file could not be read.',
};

export function registerAgentFileActions(tools: AgentToolRegistry, db: Database) {
  // Only a run's answer carries a file: a local client attaches its own files as its person (as with pictures, #1217). The registry an
  // owner's Approve uses has no `run`: there the tool is always there to re-execute a saved call.
  if (tools.run === false) { tools.omit('flux_attach_file'); return; }
  tools.forAccess('write', { operation: OPERATION, classes: AGENT_OPERATION_CLASSES[OPERATION] }).registerTool('flux_attach_file', {
    title: 'Attach a file to your answer',
    // Short on purpose: a run's tool definitions travel with every request.
    description: 'Attach a file to your answer, as your asker would attach one: `path` of a file you made in your working directory, or a text file\'s `content` with its `name`. HTML, PDF, CSV, Markdown, JSON, text, pictures and more, at most 5 MB. Your asker sees it and can show it to everyone.',
    inputSchema: z.strictObject({ ...actionInput(),
      path: z.string().min(1).max(512).optional(),
      content: z.string().min(1).max(FILE_LIMITS.fileBytes).optional(),
      name: z.string().min(1).max(FILE_LIMITS.nameChars).optional().describe('The file name people see, with its extension.') }),
    annotations,
  }, async (args, call) => {
    const input = args as typeof args & { assistantCall?: AssistantCall };
    try { return await attach(db, input, call); } catch (error) {
      if (error instanceof Refused) return call.claims.approval ? toolError(new DomainError(422, 'FILE_NOT_ATTACHED', error.message)) : refusal(error.message);
      return toolError(error);
    }
  });
}

/** The run's own runtime place: its owner's binding and the slot it lives in. */
async function runtimeTarget(db: Database, ownerUserId: string): Promise<{ bindingId: string; slot: string } | null> {
  const result = await db.execute<{ id: string; slot: string }>(sql`SELECT id, slot FROM agent_runtime_bindings WHERE owner_user_id = ${ownerUserId} AND state = 'active' LIMIT 1`);
  const row = result.rows[0];
  return row ? { bindingId: row.id, slot: row.slot } : null;
}

async function attach(db: Database, input: { projectId: string; clientCommandId: string; sources: { materialId: string; version: number }[]; path?: string | undefined;
  content?: string | undefined; name?: string | undefined; assistantCall?: AssistantCall }, { claims }: ToolCall) {
  const current = services;
  if (!current) refuse('Files cannot be attached on this server.');
  const runId = claims.run?.id ?? claims.approval?.runId ?? null;
  if (!runId) refuse('Only an answer to /ai in a space can carry a file.');
  if (claims.run && (input.projectId ?? null) !== claims.run.projectId) throw new DomainError(403, 'OUTSIDE_RUN_PLACE', 'An assistant run changes only the project it was asked in');
  if (claims.run && claims.run.projectId === null) refuse('In your private chat no file can be attached yet; describe it in your answer.');
  // An owner's Approve re-executes the call as it was kept: its file is staged already, so it carries neither the content nor anything to read.
  if (!claims.approval && (input.path === undefined) === (input.content === undefined)) refuse('Give either `path` (a file in your working directory) or `content` (a text file\'s text), not both.');
  const name = (input.name ?? (input.path ? basename(input.path) : '')).trim();
  if (!name) refuse('Give the file a `name`, with its extension.');
  // What is kept of the call (its change line, a waiting change's OK, the fingerprint a retry and an Approve compare) is its name and path, never
  // the content: the file is staged, and a change kept for an OK stays small.
  const kept: AssistantCall | undefined = input.assistantCall ? { ...input.assistantCall, args: Object.fromEntries(Object.entries({ ...input.assistantCall.args, name })
    .filter(([key]) => key !== 'content')) as AssistantCall['args'] } : undefined;
  const facts = await db.transaction(async (tx) => {
    const r = schema.personalRuns;
    const [run] = await tx.select({ ownerUserId: r.ownerUserId, projectId: r.projectId, workspaceId: r.workspaceId, agentId: r.agentId, kind: r.kind,
      engine: r.engine, shownAt: r.shownAt, dismissedAt: r.dismissedAt }).from(r).where(eq(r.id, runId!));
    if (!run || run.ownerUserId !== claims.ownerUserId || run.projectId !== input.projectId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const [space] = await tx.select({ encrypted: schema.workspaces.encrypted }).from(schema.workspaces).where(eq(schema.workspaces.id, run.workspaceId));
    if (!space || space.encrypted) return { ...run, encrypted: true, attached: 0 };
    if (claims.run) await agentConnectionInTransaction(tx, claims, 'read', input.projectId);
    const c = schema.assistantChanges;
    const attached = (await tx.select({ id: c.id }).from(c).where(and(eq(c.runId, runId!), inArray(c.operation, ['answer.picture.attach', OPERATION]),
      inArray(c.state, ['applied', 'applied_after_wait', 'waiting'])))).length;
    return { ...run, encrypted: false, attached };
  });
  // "No AI in encrypted spaces": a file never joins a sealed space through an agent.
  if (facts.encrypted) refuse('This space is encrypted, so no file can be attached here.');
  if (!PICTURE_RUN_KINDS.has(facts.kind)) refuse('Only an answer to /ai in a space can carry a file.');
  if (facts.shownAt || facts.dismissedAt) refuse('The answer was already posted or put away, so no file can be added to it.');
  const uploadId = derivedUuid('flux.agent-file.v1', runId!, input.clientCommandId.toLowerCase());
  const files = fileUseCases(db, current!.storage, current!.options);
  let staged: StagedFile | null = null;
  // The run's own call stages the file now, whatever the change will do: its scratch is gone once the run ends, and an owner's Approve finds it
  // staged under the same id. Approve itself reads nothing.
  if (!claims.approval) {
    if (facts.attached >= FILE_LIMITS.messageFiles) refuse(`An answer carries at most ${FILE_LIMITS.messageFiles} files.`);
    const largest = Math.max(FILE_LIMITS.fileBytes, files.limits().videoBytes);
    let body: Readable; let size: number | undefined;
    if (input.path !== undefined) {
      if (facts.engine !== 'runtime') refuse('You have no working directory of your own here, so give the file\'s `content` instead.');
      if (!current!.manager) refuse(READ_WORDS.no_sandbox);
      const target = await runtimeTarget(db, claims.ownerUserId);
      if (!target) refuse(READ_WORDS.unreachable);
      const read = await fetchRunFile(current!.manager!, target!.slot, { bindingId: target!.bindingId, runId: runId!, path: input.path, maxBytes: largest });
      if (!read.ok) refuse(READ_WORDS[read.code]);
      body = (read as Extract<typeof read, { ok: true }>).body;
    } else {
      const bytes = Buffer.from(input.content!, 'utf8');
      body = Readable.from([bytes]);
      size = bytes.length;
    }
    try { staged = await files.stage({ kind: 'human', id: claims.ownerUserId }, input.projectId, { uploadId, name }, body, size); }
    catch (error) {
      body.destroy();
      if (error instanceof DomainError) refuse(error.message);
      throw error;
    }
  }
  let made = false;
  let waiting = false;
  try {
    const value = await nativeActionExecutor(db, claims)({ projectId: input.projectId, clientCommandId: input.clientCommandId, sources: input.sources, ...(kept ? { assistantCall: kept } : {}) }, OPERATION, null, { name, ...(input.path ? { path: input.path } : {}) } as AgentJsonValue, async ({ transaction }) => {
      // The upload this call staged (its id is derived from the run and the call, so a retry and an owner's Approve find the same one).
      const rows = fileRows(transaction as DbExecutor);
      const upload = await rows.findUpload(input.projectId, { kind: 'human', id: claims.ownerUserId }, uploadId);
      const [row] = upload ? await rows.lockFiles([upload.id]) : [];
      if (!row || row.state !== 'ready' || row.messageId !== null || row.uploader.id !== claims.ownerUserId) throw new DomainError(409, 'FILE_NOT_KEPT', 'The file was not kept; attach it again.');
      made = true;
      return { value: { fileId: row.id, name: row.name, size: row.size }, postconditions: [] };
    });
    if (isAssistantText(value)) {
      // Waiting for the owner's OK: the staged file waits with it (it goes after 7 days unless Approve attaches it).
      const stored = await assistantChangeRows(db as unknown as DbExecutor).byCommand(runId!, input.clientCommandId).catch(() => null);
      waiting = stored?.state === 'waiting';
      return toolResult(value);
    }
    if (value.replayed) made = true;
    return toolResult({ attached: value.name, size: value.size,
      note: 'The file is attached to your answer. Your asker sees it with the answer and can show both to everyone.' });
  } finally {
    // A file whose change was neither made nor left waiting (refused, failed) is not left staged for the asker.
    if (staged && !made && !waiting) await db.transaction((tx) => fileRows(tx as DbExecutor).removeUnpublished(staged!.id)).catch(() => undefined);
  }
}
