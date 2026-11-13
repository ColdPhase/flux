import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { AGENT_OPERATION_CLASSES, FILE_LIMITS, PICTURE_RUN_KINDS, type AgentJsonValue, type StagedFile } from '@flux/contracts';
import { DomainError, derivedUuid, receiveRunOwnFile, type FileStorage, type FileUseCaseOptions } from '@flux/core';
import { assistantChangeRows, fileRows, runPictureRows, schema, type Database, type DbExecutor } from '@flux/db';
import { fetchRunFile, type RunFileError } from '@flux/runtime-protocol';
import { fileUseCases } from '../files/adapters.js';
import { setAgentFileStorage } from './file-storage.js';
import { actionAnnotations as annotations, actionInput, nativeActionExecutor } from './action-execution.js';
import { isAssistantText, type AssistantCall } from './assistant-changes.js';
import { agentConnectionInTransaction } from './context.js';
import type { AgentToolRegistry, ToolCall } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/**
 * `flux_attach_file` (#1437, RT-5, AG-8): an agent attaches a file to its answer to `/ai` in a space, as its asker would attach one. A run on
 * the owner's Claude Code or Codex, or an API-key run in pi (#1441), names a file it made in its scratch (`path`): the server asks the run's supervisor for it through
 * runtime-manager, which reads it as the run's person with Flux's sandbox reader (only a regular file inside that run's scratch, while the run
 * lasts). Any run, an API-key run included, can instead give a text file's `content`. Either way the bytes go through the asker's own upload
 * path (`stage`): the same types, size limits and checks as a person's upload (magic bytes, a picture decoded and written again, #1343, a
 * video's own limit, C-61), the same preview, staged for the asker alone until their Show everyone posts it with the answer.
 *
 * Attaching is a change of AG-3, through the same executor as every other: under "Do it and tell me" it is made at once, with its line and
 * Undo; under "Ask me first" the file is staged now (the scratch is gone once the run ends) and joins the answer only on the owner's
 * Approve. Never in an encrypted space. A refusal comes back as plain words.
 */

interface FileServices { storage: FileStorage; options: FileUseCaseOptions; manager: { url: string; secret: string } | null }
let services: FileServices | null = null;
export function configureAgentFiles(next: FileServices | null) { services = next; setAgentFileStorage(next?.storage ?? null); }

const OPERATION = 'answer.file.attach' as const;
const refusal = (words: string) => ({ content: [{ type: 'text' as const, text: `Not attached. ${words}` }], isError: true as const });
class Refused extends Error {}
const refuse = (words: string): never => { throw new Refused(words); };

/** What the supervisor's answer means, for the agent. */
const READ_WORDS: Record<RunFileError, string> = {
  file_missing: 'There is no such file in your working directory.',
  file_not_regular: 'That is not a file (a folder or a link cannot be attached).',
  file_too_large: 'The file is larger than a file in Flux may be.',
  file_secret: 'The file holds the sign-in of the AI tool you run on (a value of its login file), so it was not attached. Never copy anything of your own login into a file.',
  not_running: 'Your run has ended, so its files are gone.',
  no_sandbox: 'This server runs no tools of your own, so give the file\'s content instead.',
  invalid_request: 'The path is not one Flux can read.',
  unauthorized: 'The runtime could not be reached.', unknown_slot: 'The runtime could not be reached.', no_binding: 'The runtime could not be reached.',
  binding_unsafe: 'The runtime could not be reached.', internal: 'The file could not be read.', unreachable: 'The runtime could not be reached.',
  timeout: 'The file took too long to arrive.', protocol: 'The file could not be read.',
};

export function registerAgentFileActions(tools: AgentToolRegistry, db: Database) {
  // A local client (the owner's own Claude Code or Codex over MCP; coordinator decision on #1437): the file goes on the message it posts.
  // The registry an owner's Approve uses has no `run`: there the run's tool is always there to re-execute a saved call.
  if (tools.run === false) { registerClientFile(tools, db); return; }
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

/** The bytes a run attaches: a file of its scratch (a CLI run in the runtime), or the text it gave. */
async function runFileBody(db: Database, current: FileServices, claims: ToolCall['claims'], runId: string, engine: string,
  input: { path?: string | undefined; content?: string | undefined }, maxBytes: number): Promise<{ body: Readable; size: number | undefined }> {
  if (input.path === undefined) {
    const bytes = Buffer.from(input.content!, 'utf8');
    return { body: Readable.from([bytes]), size: bytes.length };
  }
  const noDirectory = 'You have no working directory of your own here, so give the file\'s `content` instead.';
  // An API-key run keeps the engine label `server` whether the worker's own loop or pi in the runtime runs it (#1441): only the runtime
  // knows. A run of the worker's loop is in no slot, so the supervisor answers that it is not running there.
  if (!current.manager) refuse(engine === 'server' ? noDirectory : READ_WORDS.no_sandbox);
  const target = await runtimeTarget(db, claims.ownerUserId);
  if (!target) refuse(engine === 'server' ? noDirectory : READ_WORDS.unreachable);
  const read = await fetchRunFile(current.manager!, target!.slot, { bindingId: target!.bindingId, runId, path: input.path, maxBytes });
  if (!read.ok) refuse(engine === 'server' && (read.code === 'not_running' || read.code === 'no_binding') ? noDirectory : READ_WORDS[read.code]);
  return { body: (read as Extract<typeof read, { ok: true }>).body, size: undefined };
}

/**
 * A file on the agent's answer in its private chat (coordinator decision on #1437, as #1217's pictures, C-59). The chat changes nothing (C-38)
 * and has no change log: the file is part of the agent's answer to its owner alone, made at once whatever "What it may do" says. Its bytes get
 * a person's upload checks (`receiveRunOwnFile`: a name a person could give, at most 5 MiB, no video, a picture written again) and are kept as
 * the run's own (`personal_run_pictures`), which only its owner can open, with the run. At most 10 to an answer.
 */
async function attachInChat(db: Database, current: FileServices, input: { clientCommandId: string; path?: string | undefined; content?: string | undefined; name: string },
  claims: ToolCall['claims']) {
  const run = claims.run!;
  const facts = await db.transaction(async (tx) => {
    await agentConnectionInTransaction(tx, claims, 'read', null);
    const r = schema.personalRuns;
    const [row] = await tx.select({ kind: r.kind, dmId: r.dmId, workspaceId: r.workspaceId, engine: r.engine }).from(r).where(eq(r.id, run.id));
    const [space] = row ? await tx.select({ encrypted: schema.workspaces.encrypted }).from(schema.workspaces).where(eq(schema.workspaces.id, row.workspaceId)) : [];
    return { row, encrypted: !space || space.encrypted, files: await runPictureRows(tx as DbExecutor).forRun(run.id) };
  });
  if (!facts.row || facts.row.dmId !== null || facts.row.kind !== 'ask') refuse('Only an answer in a space or in your private chat can carry a file.');
  if (facts.encrypted) refuse('This space is encrypted, so no file can be attached here.');
  const id = derivedUuid('flux.agent-chat-file.v1', run.id, input.clientCommandId.toLowerCase());
  const again = facts.files.find((file) => file.id === id);
  if (again) return toolResult({ attached: again.name, size: again.size, replayed: true });
  if (facts.files.length >= FILE_LIMITS.messageFiles) refuse(`An answer carries at most ${FILE_LIMITS.messageFiles} files.`);
  const { body } = await runFileBody(db, current, claims, run.id, facts.row!.engine, input, FILE_LIMITS.fileBytes);
  let received: Awaited<ReturnType<typeof receiveRunOwnFile>>;
  try { received = await receiveRunOwnFile(current.storage, current.options, input.name, body); }
  catch (error) { body.destroy(); if (error instanceof DomainError) refuse(error.message); throw error; }
  let saved: { name: string; size: number } | null;
  try {
    saved = await db.transaction(async (tx) => {
      // One call of this id at a time (a retry racing the first): the first saves it, the other finds it saved and touches nothing.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`run-picture:${id}`}))`);
      // The run is checked live again before the file is its: a run stopped meanwhile keeps nothing.
      await agentConnectionInTransaction(tx, claims, 'read', null);
      const rows = runPictureRows(tx as DbExecutor);
      const existing = await rows.find(id);
      if (existing) return { name: existing.name, size: existing.size };
      if ((await rows.forRun(run.id)).length >= FILE_LIMITS.messageFiles) throw new Refused(`An answer carries at most ${FILE_LIMITS.messageFiles} files.`);
      await received.received.commit(id);
      await rows.add({ id, runId: run.id, ownerUserId: claims.ownerUserId, name: received.name, size: received.received.size, sha256: received.received.sha256,
        position: (await rows.forRun(run.id)).length });
      return null;
    });
  } catch (error) {
    await received.received.discard().catch(() => undefined);
    const kept = await runPictureRows(db as unknown as DbExecutor).find(id).catch(() => null);
    if (!kept) await current.storage.remove(id).catch(() => undefined);
    throw error;
  }
  if (saved) {
    await received.received.discard().catch(() => undefined);
    return toolResult({ attached: saved.name, size: saved.size, replayed: true });
  }
  return toolResult({ attached: received.name, size: received.received.size, note: 'The file is attached to your answer in this chat; only your owner sees it.' });
}

/**
 * A local client's file (the owner's own Claude Code or Codex over MCP; coordinator decision on #1437, one contract for every agent, #1441):
 * it gives the file's content (text, or base64 for any other file), and the server stages it as its owner's own upload in that space, with the
 * same checks, staged for the owner alone. The message the client then posts names it (`attachmentIds` of `flux_start_conversation` or
 * `flux_reply_in_conversation`), and the file goes with that message, which is the owner's, marked with the client, like any of their posts.
 */
function registerClientFile(tools: AgentToolRegistry, db: Database) {
  tools.forAccess('write', { operation: OPERATION, classes: AGENT_OPERATION_CLASSES[OPERATION] }).registerTool('flux_attach_file', {
    title: 'Attach a file to your next message',
    description: 'Stage a file for the message you post next in this project: its `name` with the extension and its `content` (the text, or with '
      + '`encoding` "base64" the bytes of any other file, at most 5 MB). It is checked as your owner\'s own upload. The result gives its `fileId`: '
      + 'name it in `attachmentIds` of flux_start_conversation or flux_reply_in_conversation within 7 days. Until then only your owner sees it.',
    inputSchema: z.strictObject({ ...actionInput(),
      content: z.string().min(1).max(Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 + 4),
      encoding: z.enum(['text', 'base64']).optional().describe('How `content` is written: text (the default) or base64.'),
      name: z.string().min(1).max(FILE_LIMITS.nameChars).describe('The file name people see, with its extension.') }),
    annotations,
  }, async (args, { claims }) => {
    try {
      const current = services;
      if (!current) refuse('Files cannot be attached on this server.');
      if (claims.run || claims.approval) refuse('Only a client posts its own files.');
      await db.transaction((tx) => agentConnectionInTransaction(tx, claims, 'write', args.projectId));
      let bytes: Buffer;
      if (args.encoding === 'base64') {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.content.replace(/\s+/g, ''))) refuse('`content` is not base64.');
        bytes = Buffer.from(args.content, 'base64');
      } else bytes = Buffer.from(args.content, 'utf8');
      const uploadId = derivedUuid('flux.client-file.v1', claims.connectionId.toLowerCase(), args.clientCommandId.toLowerCase());
      const files = fileUseCases(db, current!.storage, current!.options);
      let staged: StagedFile;
      try { staged = await files.stage({ kind: 'human', id: claims.ownerUserId }, args.projectId, { uploadId, name: args.name.trim() }, Readable.from([bytes]), bytes.length); }
      catch (error) { if (error instanceof DomainError) refuse(error.message); throw error; }
      return toolResult({ fileId: staged!.id, name: staged!.name, size: staged!.size, expiresAt: staged!.expiresAt,
        note: 'Staged for your owner alone. Name this fileId in attachmentIds of the message you post next.' });
    } catch (error) {
      if (error instanceof Refused) return refusal(error.message);
      return toolError(error);
    }
  });
}

async function attach(db: Database, input: { projectId: string; clientCommandId: string; sources: { materialId: string; version: number }[]; path?: string | undefined;
  content?: string | undefined; name?: string | undefined; assistantCall?: AssistantCall }, { claims }: ToolCall) {
  const current = services;
  if (!current) refuse('Files cannot be attached on this server.');
  const runId = claims.run?.id ?? claims.approval?.runId ?? null;
  if (!runId) refuse('Only an answer to /ai in a space can carry a file.');
  if (claims.run && (input.projectId ?? null) !== claims.run.projectId) throw new DomainError(403, 'OUTSIDE_RUN_PLACE', 'An assistant run changes only the project it was asked in');
  // An owner's Approve re-executes the call as it was kept: its file is staged already, so it carries neither the content nor anything to read.
  if (!claims.approval && (input.path === undefined) === (input.content === undefined)) refuse('Give either `path` (a file in your working directory) or `content` (a text file\'s text), not both.');
  const name = (input.name ?? (input.path ? basename(input.path) : '')).trim();
  if (!name) refuse('Give the file a `name`, with its extension.');
  // The agent's private chat (coordinator decision on #1437, as #1217's pictures): the file is part of its answer to its owner alone.
  if (claims.run && claims.run.projectId === null) return attachInChat(db, current!, { ...input, name }, claims);
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
    const { body, size } = await runFileBody(db, current!, claims, runId!, facts.engine, input, Math.max(FILE_LIMITS.fileBytes, files.limits().videoBytes));
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
