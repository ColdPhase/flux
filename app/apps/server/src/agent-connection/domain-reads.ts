import type { AgentToolRegistrar, ToolCall } from './tool-registry.js';
import { z } from 'zod';
import { conversationUseCases, createSearchUseCases, DomainError, getProject, NotFoundError } from '@flux/core';
import { accessPorts, schema, type Database } from '@flux/db';
import { eq } from 'drizzle-orm';
import { conversationStore } from '../conversation/store.js';
import { docUseCases } from '../docs/adapters.js';
import { workUseCases } from '../work/adapters.js';
import { sketchUseCases } from '../sketches/adapters.js';
import { taskDiscussionInTransaction } from '../work/task-discussions.js';
import { policySearchAccess, searchRepository } from '../search/adapters.js';
import { SearchCursorCodec } from '../search/cursor.js';
import { withAgentConnection } from './context.js';
import { toolError, toolResult } from './tool-results.js';

const page = { limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10_000).default(0) };
const projectPage = z.object({ projectId: z.uuid(), ...page });
const object = z.object({ projectId: z.uuid(), id: z.uuid() });
const chunk = { offset: z.int().min(0).max(100_000).default(0), version: z.int().min(1).optional() };
const TEXT_CHUNK = 20_000;
/**
 * A personal run's pages stay small, so a long read costs no more than it must and stays far from the route's safety
 * bound. The text page is 12,000 characters, and its encoded bytes (counted as the route counts them: the tool JSON
 * is encoded again in the content) stay under 12 KiB, leaving room for metadata.
 * Collections return at most 10 items per page. Continuation cursors are unchanged.
 */
const RUN_TEXT_CHUNK = 12_000;
const RUN_TEXT_ENCODED_BYTES = 12 * 1024;
const RUN_PAGE_LIMIT = 10;
const annotations = { readOnlyHint: true };

/** Chunking always reports coverage; a continuation cannot silently switch source versions. */
function textChunk(body: string, version: number, offset: number, expected: number | undefined, run: boolean) {
  if (offset > 0 && expected === undefined)
    throw new DomainError(400, 'VERSION_REQUIRED', 'A continuation needs the source version from the first page');
  if (expected !== undefined && version !== expected)
    throw new DomainError(409, 'SOURCE_VERSION_CONFLICT', 'The source changed; read it again from the first page');
  const end = run ? runChunkEnd(body, offset) : Math.min(body.length, offset + TEXT_CHUNK);
  return { body: body.slice(offset, end), offset, totalLength: body.length, nextOffset: end < body.length ? end : null };
}

/** The end of a run's text page: at most 12,000 characters, shorter while its encoded size is over 12 KiB, never inside a surrogate pair. */
function runChunkEnd(body: string, offset: number) {
  let end = Math.min(body.length, offset + RUN_TEXT_CHUNK);
  while (end > offset + 1 && Buffer.byteLength(JSON.stringify(JSON.stringify(body.slice(offset, end))), 'utf8') > RUN_TEXT_ENCODED_BYTES)
    end = offset + Math.floor((end - offset) * 0.8);
  if (end < body.length && end - 1 > offset && /[\uD800-\uDBFF]/.test(body[end - 1]!)) end -= 1;
  return end;
}

/** Canonical readers under the owner's rights. No separate MCP object model. */
export function registerAgentDomainReads(server: AgentToolRegistrar, db: Database, cursorSecret: string) {
  const cursors = new SearchCursorCodec(cursorSecret);
  const isRun = ({ claims }: ToolCall) => claims.run !== undefined;
  const pageLimit = (call: ToolCall, limit: number) => isRun(call) ? Math.min(limit, RUN_PAGE_LIMIT) : limit;
  const capped = <T extends { limit: number }>(call: ToolCall, query: T): T => ({ ...query, limit: pageLimit(call, query.limit) });
  async function result<T>({ claims }: ToolCall, projectId: string | null, read: Parameters<typeof withAgentConnection<T>>[4]) {
    try { return toolResult(await withAgentConnection(db, claims, 'read', projectId, read)); }
    catch (error) { return toolError(error); }
  }

  server.registerTool('flux_list_contexts', { title: 'List your Flux projects',
    description: 'List the projects you can read and this connection can still use.', inputSchema: z.object({}), annotations },
  (_input, call) => result(call, null, async ({ tx, reachable, principal, requireProject }) => {
    const projects = [];
    for (const id of await reachable()) {
      // A space the connection cannot use now (AI turned off there, access lost) is left out; the others are still listed (AG-10).
      try {
        await requireProject(id);
        const project = await getProject(principal, id, tx, accessPorts);
        projects.push({ id: project.id, name: project.name, workspaceId: project.workspaceId });
      } catch (error) { if (!(error instanceof DomainError)) throw error; }
    }
    return { projects };
  }));

  server.registerTool('flux_list_materials', { title: 'List project sources',
    description: 'A page of material and wiki IDs, titles and versions. No private drafts.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, async ({ tx, principal }) =>
    ({ projectId, ...await conversationStore(tx).listSourceMaterials(principal, projectId, capped(call, query)) })));

  server.registerTool('flux_read_material', { title: 'Read a project material',
    description: 'Read source text in 20,000-character pages; continue with nextOffset and the same version.',
    inputSchema: z.object({ projectId: z.uuid(), materialId: z.uuid(), ...chunk }), annotations },
  ({ projectId, materialId, offset, version }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'material', materialId);
    const material = await conversationStore(tx).getMaterial(principal, materialId);
    return { projectId, materialId: material.materialId, version: material.version, title: material.title,
      url: material.url, updatedAt: material.updatedAt, ...textChunk(material.body, material.version, offset, version, isRun(call)) };
  }));

  server.registerTool('flux_list_work', { title: 'List native project tasks',
    description: 'A page of the project board\'s tasks, with versions and links.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, ({ tx, principal }) => workUseCases(tx).listWork(principal, projectId, capped(call, query))));
  server.registerTool('flux_get_work', { title: 'Read a native task', description: 'Read one task.',
    inputSchema: object, annotations }, ({ projectId, id }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'work', id); return workUseCases(tx).getWork(principal, id);
  }));
  server.registerTool('flux_list_decisions', { title: 'List project decisions', description: 'A page of decisions: proposed, accepted and superseded.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, ({ tx, principal }) => workUseCases(tx).listDecisions(principal, projectId, capped(call, query))));
  server.registerTool('flux_get_decision', { title: 'Read a project decision', description: 'Read one decision, its authors and status.',
    inputSchema: object, annotations }, ({ projectId, id }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'decision', id); return workUseCases(tx).getDecision(principal, id);
  }));

  server.registerTool('flux_list_docs', { title: 'List project wiki', description: 'A page of wiki titles, versions and publication states.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, ({ tx, principal }) => docUseCases(tx).listProjectDocs(principal, projectId, capped(call, query))));
  server.registerTool('flux_get_doc', { title: 'Read project wiki text',
    description: 'Read a wiki document in 20,000-character pages; continue with nextOffset and the same version.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...chunk }), annotations },
  ({ projectId, id, offset, version }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'doc', id);
    const { body, html: _html, ...doc } = await docUseCases(tx).getDoc(principal, id);
    void _html;
    return { ...doc, ...textChunk(body, doc.version, offset, version, isRun(call)) };
  }));

  server.registerTool('flux_list_conversations', { title: 'List project conversations', description: 'A page of project conversations.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, ({ tx, principal }) => conversationUseCases(conversationStore(tx)).listConversations(principal, projectId, capped(call, query))));
  server.registerTool('flux_get_conversation', { title: 'Read a project conversation',
    description: 'Read up to 50 messages; use nextBeforeSequence for older ones.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), limit: z.int().min(1).max(50).default(20), beforeSequence: z.int().min(1).optional() }), annotations },
  ({ projectId, id, ...query }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'conversation', id);
    return conversationUseCases(conversationStore(tx)).getConversation(principal, id, { ...query, limit: pageLimit(call, query.limit) });
  }));

  // The task's one discussion (#868): the same audience as the task. The task names its project, which must be a selected one.
  server.registerTool('flux_get_task_discussion', { title: 'Read a task\'s discussion',
    description: 'The people\'s and agents\' messages about a task, up to 50; use messagePage.nextBeforeSequence for older ones. Reading creates nothing.',
    inputSchema: z.strictObject({ taskId: z.uuid(), limit: z.int().min(1).max(50).default(20), beforeSequence: z.int().min(1).optional() }), annotations },
  async ({ taskId, limit, beforeSequence }, call) => {
    // The lookup runs inside the checked transaction (AG-10): a space with AI off answers SPACE_AI_OFF.
    return result(call, null, async ({ tx, principal, requireProject }) => {
      const [task] = await tx.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, taskId));
      if (!task) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      await requireProject(task.projectId);
      return taskDiscussionInTransaction(tx).getDiscussion(principal, taskId, { limit: pageLimit(call, limit), ...(beforeSequence === undefined ? {} : { beforeSequence }) });
    });
  });

  server.registerTool('flux_list_maps', { title: 'List project maps', description: 'A page of project maps. Private and direct-message maps are excluded.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }, call) => result(call, projectId, ({ tx, principal, workspaceId }) => sketchUseCases(tx).list(principal, workspaceId, { projectId, ...capped(call, query) })));
  server.registerTool('flux_get_map', { title: 'Read a project map',
    description: 'Read thoughts and links, up to 50 of each per page; to continue, pass the returned updatedAt as expectedUpdatedAt.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...page, linkOffset: z.int().min(0).max(10_000).default(0), expectedUpdatedAt: z.string().max(64).optional() }), annotations },
  ({ projectId, id, limit, offset, linkOffset, expectedUpdatedAt }, call) => result(call, projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'sketch', id);
    return sketchUseCases(tx).getWindow(principal, id, { limit: pageLimit(call, limit), offset, linkOffset, expectedUpdatedAt });
  }));

  server.registerTool('flux_search_project', { title: 'Search a project',
    description: 'Search project content: snippets and a cursor for more. Private, direct-message and person results are excluded.',
    inputSchema: z.object({ projectId: z.uuid(), q: z.string().min(1).max(200), type: z.enum(['message', 'doc', 'material', 'work', 'decision', 'sketch']).optional(),
      cursor: z.string().max(500).optional(), limit: page.limit }), annotations },
  ({ projectId, ...query }, call) => {
    return result(call, projectId, async ({ tx, principal, workspaceId }) => {
    const access = policySearchAccess(tx);
    const search = createSearchUseCases({ rows: searchRepository(tx), cursors,
      access: { audiences: async (actor) => (await access.audiences(actor)).filter((audience) =>
        (audience.type === 'project' || audience.type === 'sketch') && audience.workspaceId === workspaceId) } });
    return search.search(principal, { ...capped(call, query), place: `project:${projectId}` });
    });
  });
}
