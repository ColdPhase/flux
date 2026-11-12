import { Readable } from 'node:stream';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AGENT_OPERATION_CLASSES, FILE_LIMITS, PICTURE_RUN_KINDS, type AgentJsonValue, type StagedFile } from '@flux/contracts';
import { addressChain, ADDRESS_MAX, DomainError, derivedUuid, normalizedAddress, pictureName, requireSpaceAi, SpaceAiOffError, type FileStorage,
  type PrivateTextIndex } from '@flux/core';
import { accessReader, assistantChangeRows, fileRows, personalRunWebReadRows, runPictureRows, schema, type Database, type DbExecutor } from '@flux/db';
import { fileUseCases } from '../files/adapters.js';
import { PICTURE_WORDS, type PictureResult, type WebReader } from '../web-reads/reader.js';
import { actionAnnotations as annotations, actionInput, nativeActionExecutor } from './action-execution.js';
import { isAssistantText, type AssistantCall } from './assistant-changes.js';
import { agentConnectionInTransaction } from './context.js';
import { checkRunAddress, forgetRunPrivateText } from './run-private-text.js';
import type { AgentToolRegistry, ToolCall } from './tool-registry.js';
import { toolError, toolResult } from './tool-results.js';

/**
 * `flux_attach_image` (#1217, F-036 AG-8, C-59): an agent attaches a public picture to its answer to `/ai` in a space. The Flux server, never
 * the agent's process, downloads it with the web reads' guard and switch (`WebReader.picture`: public addresses only, the name resolved once
 * and that answer connected to, at most 3 redirects each judged again, short timeouts, at most 5 MiB read whole), keeps only the picture
 * (`cleanPicture`: PNG, JPEG, WebP or GIF by its bytes, never SVG, metadata and anything after its end dropped, a pixel bound), and stages
 * it as a file of the asker's, through the same stored-files path as a person's upload: only the asker can open it, in their private answer
 * card, until their Show everyone posts it with the answer as an ordinary attachment.
 *
 * Attaching is a change of AG-3, made through the same change executor as every other: under "Do it and tell me" it is fetched and made at
 * once, with its line and Undo; under "Ask me first" it waits, and nothing is fetched until the owner's Approve re-executes this call; under
 * "Only read" it is refused. As on a page read, the address and each redirect hop may carry no private Flux text the run read (C-30), and
 * every address the server asked for is listed with the run's sources. Never in an encrypted space. A refusal comes back as plain words.
 */

/** The services the tool needs, set once by the API's composition (also for an owner's Approve, which re-executes a saved call). */
interface PictureServices { reader: WebReader; storage: FileStorage }
let services: PictureServices | null = null;
export function configureAgentPictures(next: PictureServices | null) { services = next; }
/** The files volume, for a picture a run looks at (`flux_view_image`). */
export const pictureStorage = () => services?.storage ?? null;

const OPERATION = 'answer.picture.attach' as const;
/** Plain words in place of a picture: an error result whose text the agent passes on, never a code. */
const refusal = (words: string) => ({ content: [{ type: 'text' as const, text: `Not attached. ${words}` }], isError: true as const });
class Refused extends Error {}
const refuse = (words: string): never => { throw new Refused(words); };
/** The outcomes of an address a picture fetch asked, as the run's list of sources names them (the page reads' words). */
const OUTCOMES = new Set<string>(['blocked', 'unreachable', 'timeout', 'status', 'type', 'redirects', 'invalid']);

export function registerAgentPictureActions(tools: AgentToolRegistry, db: Database) {
  // Only a run's answer carries a picture: a local client attaches its own files as its person (and gets no tool), and with the web off there
  // is nothing to fetch with. The registry an owner's Approve uses has no `run`: there the tool is always there to re-execute a saved call.
  if (tools.run === false || (tools.run === true && !services?.reader.enabled)) { tools.omit('flux_attach_image'); return; }
  tools.forAccess('write', { operation: OPERATION, classes: AGENT_OPERATION_CLASSES[OPERATION] }).registerTool('flux_attach_image', {
    title: 'Attach a picture to your answer',
    // Short on purpose: a run's tool definitions travel with every request (assistant-run-tokens.test.ts).
    description: 'Attach a picture from a public web address to your answer: PNG, JPEG, WebP or GIF, at most 5 MB. Your asker sees it and can show it to everyone. Never put anything from Flux into the address.',
    inputSchema: z.strictObject({ ...actionInput(),
      // The brief says what address to give (`PICTURE_LINE`); the run's definitions travel with every request, so these say no more.
      url: z.string().min(1).max(2048),
      caption: z.string().max(120).optional().describe('What it shows.') }),
    annotations: { ...annotations, openWorldHint: true },
  }, async (args, call) => {
    const input = args as typeof args & { assistantCall?: AssistantCall };
    try { return await attach(db, input, call); } catch (error) {
      // To the agent, plain words; to its owner's Approve, the same words as the reason it was not made.
      if (error instanceof Refused) return call.claims.approval ? toolError(new DomainError(422, 'PICTURE_NOT_ATTACHED', error.message)) : refusal(error.message);
      return toolError(error);
    }
  });
}

async function attach(db: Database, input: { projectId: string; clientCommandId: string; sources: { materialId: string; version: number }[]; url: string;
  caption?: string | undefined; assistantCall?: AssistantCall }, { claims }: ToolCall) {
  const current = services;
  if (!current?.reader.enabled) refuse(PICTURE_WORDS.off);
  const runId = claims.run?.id ?? claims.approval?.runId ?? null;
  if (!runId) refuse('Only an answer to /ai in a space can carry a picture.');
  // A run changes only its place (AST-5.3): the same refusal as every other change tool, before anything is read.
  if (claims.run && (input.projectId ?? null) !== claims.run.projectId) throw new DomainError(403, 'OUTSIDE_RUN_PLACE', 'An assistant run changes only the project it was asked in');
  // The agent's private chat (founder decision on #1217, 2026-11-12): no space, no change log; the picture is part of its answer to its owner.
  if (claims.run && claims.run.projectId === null) return attachInChat(db, current!, input, claims);
  // What decides whether to fetch, read before anything is sent: the run, its space, and "What it may do". A run's own call checks its token
  // and place first; an owner's Approve is checked again by the change executor, and here only for what makes the fetch pointless.
  const facts = await db.transaction(async (tx) => {
    const r = schema.personalRuns;
    const [run] = await tx.select({ ownerUserId: r.ownerUserId, projectId: r.projectId, workspaceId: r.workspaceId, agentId: r.agentId, kind: r.kind,
      shownAt: r.shownAt, dismissedAt: r.dismissedAt }).from(r).where(eq(r.id, runId!));
    if (!run || run.ownerUserId !== claims.ownerUserId || run.projectId !== input.projectId) throw new DomainError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const [space] = await tx.select({ encrypted: schema.workspaces.encrypted }).from(schema.workspaces).where(eq(schema.workspaces.id, run.workspaceId));
    if (!space || space.encrypted) return { ...run, encrypted: true, mayDo: null, pictures: 0 };
    try {
      if (claims.run) await agentConnectionInTransaction(tx, claims, 'read', input.projectId);
      else await requireSpaceAi(accessReader(tx as DbExecutor), run.projectId!);
    } catch (error) {
      if (error instanceof SpaceAiOffError) refuse('AI is off in this space, so no picture can be attached here.');
      throw error;
    }
    const settings = await assistantChangeRows(tx as DbExecutor).settings(claims.ownerUserId, run.agentId);
    const c = schema.assistantChanges;
    const pictures = (await tx.select({ id: c.id }).from(c).where(and(eq(c.runId, runId!), eq(c.operation, OPERATION), inArray(c.state, ['applied', 'applied_after_wait'])))).length;
    return { ...run, encrypted: false, mayDo: settings?.mayDo ?? null, pictures };
  });
  // F-030 and "No AI in encrypted spaces": an address would reach a third party for a space whose content is sealed.
  if (facts.encrypted) refuse('This space is encrypted, so no picture from the web can be attached here.');
  if (!PICTURE_RUN_KINDS.has(facts.kind)) refuse('Only an answer to /ai in a space can carry a picture.');
  if (facts.shownAt || facts.dismissedAt) refuse('The answer was already posted or put away, so no picture can be added to it.');
  const execute = nativeActionExecutor(db, claims);
  // C-30 before anything is saved or sent, whatever the change will do: an address that carries private Flux text the run read is refused
  // in plain words, so no such address ever waits for an OK (the review of #1288, P1).
  if (claims.run) await checkedAddress(db, runId!, input.url);
  // Fetched only when the change will be made now: under Ask me first or Only read nothing is sent to the site before the owner's OK.
  let staged: StagedFile | null = null;
  if (claims.approval || facts.mayDo === 'act') {
    if (facts.pictures >= FILE_LIMITS.messageFiles) refuse(`An answer carries at most ${FILE_LIMITS.messageFiles} pictures.`);
    // An owner's Approve checks the address and every redirect hop against the run's private text as the run's own call did (founder
    // decision on #1217): the run keeps that text while a picture of it waits (migration 0058). Every address asked is one of its sources.
    const fetched = await fetchPicture(db, current!.reader, runId!, input.url);
    if (!fetched.ok) refuse(PICTURE_WORDS[fetched.reason]);
    const ok = fetched as Extract<PictureResult, { ok: true }>;
    const name = pictureName(input.caption, ok.finalUrl, ok.type);
    // The asker's own staged file, as if they had attached it (C-59): the stored-files path with its access check, quota and expiry. One
    // upload per change, so a retry of the same call finds the same file.
    staged = await fileUseCases(db, current!.storage).stage({ kind: 'human', id: claims.ownerUserId }, input.projectId,
      { uploadId: derivedUuid('flux.agent-picture.v1', runId!, input.clientCommandId.toLowerCase()), name }, Readable.from([Buffer.from(ok.bytes)]), ok.bytes.length);
  }
  const file = staged;
  // Whether the staged picture is the one the change log names: made now, or made by this same call before (a retry).
  let made = false;
  try {
    const value = await execute(input, OPERATION, null, { url: input.url, ...(input.caption ? { caption: input.caption } : {}) } as AgentJsonValue, async ({ transaction }) => {
      if (!file) throw new DomainError(409, 'PICTURE_NOT_FETCHED', 'The picture was not fetched; attach it again.');
      const [row] = await fileRows(transaction as DbExecutor).lockFiles([file.id]);
      if (!row || row.state !== 'ready' || row.messageId !== null || row.uploader.id !== claims.ownerUserId) throw new DomainError(409, 'PICTURE_NOT_FETCHED', 'The picture was not kept; attach it again.');
      made = true;
      return { value: { fileId: file.id, name: file.name, size: file.size }, postconditions: [] };
    });
    if (isAssistantText(value)) return toolResult(value);
    if (value.replayed) made = true;
    return toolResult({ attached: file!.name, size: file!.size,
      note: 'The picture is attached to your answer. Your asker sees it with the answer and can show both to everyone. Do not describe it as seen unless you looked at it.' });
  } finally {
    // A picture whose change was not made (refused, waiting after a race, failed) is not left staged for the asker.
    if (file && !made) await db.transaction((tx) => fileRows(tx as DbExecutor).removeUnpublished(file.id)).catch(() => undefined);
  }
}

/**
 * Downloads the picture, as `flux_read_web` reads a page (#953, #1136): each address and redirect hop is refused when it carries private Flux
 * text the run read, and written down as one of the run's sources before its request goes out. The same on an owner's Approve after the run
 * ended: the run keeps its private text while a picture of it waits (migration 0058).
 */
async function fetchPicture(db: Database, reader: WebReader, runId: string, url: string): Promise<PictureResult> {
  const rows = personalRunWebReadRows(db);
  const asked = normalizedAddress(url) ?? url;
  const chain = addressChain();
  let index: PrivateTextIndex | undefined;
  const check = async (address: string) => {
    let sent: string | null = null;
    try { sent = new URL(address).href; } catch { /* no web address: the reader says so */ }
    if (sent !== null && sent.split('#')[0]!.length > ADDRESS_MAX) refuse(PICTURE_WORDS.too_long);
    const checked = await checkRunAddress(db as DbExecutor, runId, address, chain, index);
    index = checked.index;
    if (checked.fragment) refuse(`${PICTURE_WORDS.private_text} (It carries "${checked.fragment}".)`);
    return checked.writable;
  };
  let first: boolean;
  try { first = await check(url); } catch (error) { forgetRunPrivateText(runId); throw error; }
  const ids: string[] = [];
  let fetched: PictureResult;
  try {
    fetched = await reader.picture(url, { beforeRequest: async (address) => {
      const writable = address === asked ? first : await check(address);
      ids.push(await rows.add(runId, { url: asked, finalUrl: address, title: null, outcome: 'asked', writable }));
    } });
  } catch (error) {
    for (const id of ids) await rows.settle(id, { outcome: 'redirected' });
    throw error;
  }
  for (const [position, id] of ids.entries()) {
    if (position < ids.length - 1) await rows.settle(id, { outcome: 'redirected' });
    else if (fetched.ok) await rows.settle(id, { outcome: 'read', title: 'Picture' });
    // A body that is not a picture, or one too large, was asked all the same: listed as not read.
    else await rows.settle(id, { outcome: OUTCOMES.has(fetched.reason) ? fetched.reason : 'type' });
  }
  return fetched;
}

/**
 * The pictures Show everyone posts with an answer (#1217, C-59): those its changes attached and nobody undid, still staged for its asker and
 * not expired, in the order they were attached. The asker posts them as their own attachments, so the message's own checks apply to them.
 */
export async function answerPictureIds(db: DbExecutor, runId: string, ownerUserId: string): Promise<string[]> {
  const c = schema.assistantChanges; const f = schema.projectFiles;
  const rows = await db.select({ id: f.id }).from(c).innerJoin(f, eq(f.id, c.objectId))
    .where(and(eq(c.runId, runId), eq(c.operation, OPERATION), inArray(c.state, ['applied', 'applied_after_wait']), eq(f.uploaderId, ownerUserId),
      eq(f.state, 'ready'), isNull(f.publishedAt), gt(f.expiresAt, new Date())))
    .orderBy(asc(c.createdAt), asc(c.id));
  return rows.map((row) => row.id).slice(0, FILE_LIMITS.messageFiles);
}

/** C-30 on the address alone (its length as sent, and the run's private text), before a change is saved: refused in plain words. */
async function checkedAddress(db: Database, runId: string, url: string) {
  let sent: string | null = null;
  try { sent = new URL(url).href; } catch { return; /* no web address: the fetch says so */ }
  if (sent.split('#')[0]!.length > ADDRESS_MAX) refuse(PICTURE_WORDS.too_long);
  try {
    const checked = await checkRunAddress(db as DbExecutor, runId, url, addressChain());
    if (checked.fragment) refuse(`${PICTURE_WORDS.private_text} (It carries "${checked.fragment}".)`);
  } catch (error) { forgetRunPrivateText(runId); throw error; }
}

/**
 * A picture on the agent's answer in its private chat (founder decision on #1217, 2026-11-12; C-59). The chat changes nothing (C-38) and has no
 * change log: the picture is part of the agent's answer to its owner alone, made at once whatever "What it may do" says, as a page read is.
 * It is downloaded and checked exactly as in a space, and kept as the run's own picture (`personal_run_pictures`), which only its owner can
 * open, with the run. At most 10 to an answer.
 */
async function attachInChat(db: Database, services: PictureServices, input: { clientCommandId: string; url: string; caption?: string | undefined },
  claims: ToolCall['claims']) {
  const run = claims.run!;
  const facts = await db.transaction(async (tx) => {
    await agentConnectionInTransaction(tx, claims, 'read', null);
    const r = schema.personalRuns;
    const [row] = await tx.select({ kind: r.kind, dmId: r.dmId, workspaceId: r.workspaceId }).from(r).where(eq(r.id, run.id));
    const [space] = row ? await tx.select({ encrypted: schema.workspaces.encrypted }).from(schema.workspaces).where(eq(schema.workspaces.id, row.workspaceId)) : [];
    const pictures = await runPictureRows(tx as DbExecutor).forRun(run.id);
    return { row, encrypted: !space || space.encrypted, pictures };
  });
  if (!facts.row || facts.row.dmId !== null || facts.row.kind !== 'ask') refuse('Only an answer in a space or in your private chat can carry a picture.');
  if (facts.encrypted) refuse('This space is encrypted, so no picture from the web can be attached here.');
  const id = derivedUuid('flux.agent-chat-picture.v1', run.id, input.clientCommandId.toLowerCase());
  const again = facts.pictures.find((picture) => picture.id === id);
  if (again) return toolResult({ attached: again.name, size: again.size, replayed: true });
  if (facts.pictures.length >= FILE_LIMITS.messageFiles) refuse(`An answer carries at most ${FILE_LIMITS.messageFiles} pictures.`);
  const fetched = await fetchPicture(db, services.reader, run.id, input.url);
  if (!fetched.ok) refuse(PICTURE_WORDS[fetched.reason]);
  const ok = fetched as Extract<PictureResult, { ok: true }>;
  const name = pictureName(input.caption, ok.finalUrl, ok.type);
  const received = await services.storage.receive(Readable.from([Buffer.from(ok.bytes)]), { maxBytes: FILE_LIMITS.fileBytes, deadline: Date.now() + FILE_LIMITS.receiveSeconds * 1000 });
  let saved: { name: string; size: number } | null = null;
  try {
    saved = await db.transaction(async (tx) => {
      // One call of this id at a time (a retry racing the first): the first saves it, the other finds it saved and touches nothing.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`run-picture:${id}`}))`);
      // The run is checked live again before the picture is its: a run stopped meanwhile keeps nothing.
      await agentConnectionInTransaction(tx, claims, 'read', null);
      const rows = runPictureRows(tx as DbExecutor);
      const existing = await rows.find(id);
      if (existing) return { name: existing.name, size: existing.size };
      await received.commit(id);
      await rows.add({ id, runId: run.id, ownerUserId: claims.ownerUserId, name, size: received.size, sha256: received.sha256, position: (await rows.forRun(run.id)).length });
      return null;
    });
  } catch (error) {
    await received.discard().catch(() => undefined);
    // Bytes this call committed under a row that never was: removed. A picture another call saved under this id is left alone.
    const kept = await runPictureRows(db as unknown as DbExecutor).find(id).catch(() => null);
    if (!kept) await services.storage.remove(id).catch(() => undefined);
    throw error;
  }
  if (saved) {
    await received.discard().catch(() => undefined);
    return toolResult({ attached: saved.name, size: saved.size, replayed: true });
  }
  return toolResult({ attached: name, size: received.size,
    note: 'The picture is attached to your answer in this chat; only your owner sees it. Do not describe it as seen unless you looked at it.' });
}
