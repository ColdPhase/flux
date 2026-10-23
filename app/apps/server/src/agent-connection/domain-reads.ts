import type { AgentToolRegistrar } from './tool-registry.js';
import { z } from 'zod';
import { conversationUseCases, createSearchUseCases, DomainError, getProject, NotFoundError, type Database } from '@flux/core';
import { schema } from '@flux/db';
import { eq } from 'drizzle-orm';
import { conversationStore } from '../conversation/store.js';
import { docUseCases } from '../docs/adapters.js';
import { workUseCases } from '../work/adapters.js';
import { sketchUseCases } from '../sketches/adapters.js';
import { policySearchAccess, searchRepository } from '../search/adapters.js';
import { SearchCursorCodec } from '../search/cursor.js';
import { requireMcpSourceKinds, withAgentConnection, type FluxMcpClaims } from './context.js';
import { toolError, toolResult } from './tool-results.js';

const page = { limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10_000).default(0) };
const projectPage = z.object({ projectId: z.uuid(), ...page });
const object = z.object({ projectId: z.uuid(), id: z.uuid() });
const chunk = { offset: z.int().min(0).max(100_000).default(0), version: z.int().min(1).optional() };
const TEXT_CHUNK = 20_000;
/**
 * A personal run's pages (F-022 "Caps"): the route returns at most 16 KiB per tool result, and the run ends
 * when a result is past it. The text page is 12,000 characters, and its encoded bytes (counted as the route
 * counts them: the tool JSON is encoded again in the content) stay under 12 KiB, leaving room for metadata.
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

/** Canonical readers under the selected-project ceiling. No separate MCP object model. */
export function registerAgentDomainReads(server: AgentToolRegistrar, db: Database, claims: FluxMcpClaims, cursorSecret: string) {
  const cursors = new SearchCursorCodec(cursorSecret);
  const run = claims.run !== undefined;
  const pageLimit = (limit: number) => run ? Math.min(limit, RUN_PAGE_LIMIT) : limit;
  const capped = <T extends { limit: number }>(query: T): T => ({ ...query, limit: pageLimit(query.limit) });
  async function result<T>(projectId: string | null, read: Parameters<typeof withAgentConnection<T>>[4]) {
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, read)); }
    catch (error) { return toolError(error); }
  }

  server.registerTool('flux_list_contexts', { title: 'List selected Flux projects',
    description: 'List the selected projects this connection can still read.', inputSchema: z.object({}), annotations },
  () => result(null, async ({ tx, connection, principal, requireProject }) => {
    const projects = [];
    for (const id of [...connection.selectedProjectIds].sort()) {
      await requireProject(id);
      const project = await getProject(principal, id, tx);
      // The project's goal is readable, never writable, through MCP (#520): one sentence, and whether a person marked it reached.
      projects.push({ id: project.id, name: project.name, workspaceId: project.workspaceId,
        goal: project.goal ? { title: project.goal.title, reachedAt: project.goal.reachedAt } : null });
    }
    return { projects };
  }));

  server.registerTool('flux_list_materials', { title: 'List project sources',
    description: 'A page of material and wiki IDs, titles and versions. No private drafts.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, async ({ tx, principal }) =>
    ({ projectId, ...await conversationStore(tx).listSourceMaterials(principal, projectId, capped(query)) })));

  server.registerTool('flux_read_material', { title: 'Read a project material',
    description: 'Read source text in 20,000-character pages; continue with nextOffset and the same version.',
    inputSchema: z.object({ projectId: z.uuid(), materialId: z.uuid(), ...chunk }), annotations },
  ({ projectId, materialId, offset, version }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'material', materialId);
    const material = await conversationStore(tx).getMaterial(principal, materialId);
    return { projectId, materialId: material.materialId, version: material.version, title: material.title,
      url: material.url, updatedAt: material.updatedAt, ...textChunk(material.body, material.version, offset, version, run) };
  }));

  server.registerTool('flux_list_work', { title: 'List native project tasks',
    description: 'A page of the project board\'s tasks, with versions and links.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listWork(principal, projectId, capped(query))));
  server.registerTool('flux_get_work', { title: 'Read a native task', description: 'Read one task.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'work', id); return workUseCases(tx).getWork(principal, id);
  }));
  server.registerTool('flux_list_decisions', { title: 'List project decisions', description: 'A page of decisions: proposed, accepted and superseded.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listDecisions(principal, projectId, capped(query))));
  server.registerTool('flux_get_decision', { title: 'Read a project decision', description: 'Read one decision, its authors and status.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'decision', id); return workUseCases(tx).getDecision(principal, id);
  }));
  server.registerTool('flux_list_results', { title: 'List project results', description: 'A page of positive and negative results.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listResults(principal, projectId, capped(query))));
  server.registerTool('flux_get_result', { title: 'Read a project result', description: 'Read one result and its source links.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'result', id); return workUseCases(tx).getResult(principal, id);
  }));

  server.registerTool('flux_list_docs', { title: 'List project wiki', description: 'A page of wiki titles, versions and publication states.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => docUseCases(tx).listProjectDocs(principal, projectId, capped(query))));
  server.registerTool('flux_get_doc', { title: 'Read project wiki text',
    description: 'Read a wiki document in 20,000-character pages; continue with nextOffset and the same version.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...chunk }), annotations },
  ({ projectId, id, offset, version }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'doc', id);
    const { body, html: _html, ...doc } = await docUseCases(tx).getDoc(principal, id);
    void _html;
    return { ...doc, ...textChunk(body, doc.version, offset, version, run) };
  }));

  server.registerTool('flux_list_conversations', { title: 'List project conversations', description: 'A page of project conversations.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => conversationUseCases(conversationStore(tx)).listConversations(principal, projectId, capped(query))));
  server.registerTool('flux_get_conversation', { title: 'Read a project conversation',
    description: 'Read up to 50 messages; use nextBeforeSequence for older ones.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), limit: z.int().min(1).max(50).default(20), beforeSequence: z.int().min(1).optional() }), annotations },
  ({ projectId, id, ...query }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'conversation', id);
    return conversationUseCases(conversationStore(tx)).getConversation(principal, id, { ...query, limit: pageLimit(query.limit) });
  }));

  // The task's agents' thread (#400): the same audience as the task. The task names its project, which must be a selected one.
  server.registerTool('flux_get_agent_thread', { title: 'Read a task\'s agents\' thread',
    description: 'Up to 50 messages; resume with afterSequence.',
    inputSchema: z.strictObject({ taskId: z.uuid(), beforeSequence: z.int().min(1).optional(), afterSequence: z.int().min(0).optional() }), annotations },
  async ({ taskId, beforeSequence, afterSequence }) => {
    // The lookup runs inside the checked transaction (F-029): a blocked workspace answers WORKSPACE_AI_BLOCKED whether or not the task exists.
    return result(null, async ({ tx, principal, requireProject }) => {
      const [task] = await tx.select({ projectId: schema.projectWorkItems.projectId }).from(schema.projectWorkItems).where(eq(schema.projectWorkItems.id, taskId));
      if (!task) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      await requireProject(task.projectId);
      const store = conversationStore(tx);
      const limit = pageLimit(50);
      const first = await store.getAgentThread(principal, taskId, { limit, beforeSequence: beforeSequence ?? null } as never);
      if (afterSequence === undefined) return { ...first, messages: first.conversation?.messages ?? [], conversation: undefined };
      // Resume: walk back until the recorded sequence is covered, then return what follows it, oldest first.
      let messages = first.conversation?.messages ?? [];
      let before = first.conversation?.messagePage.nextBeforeSequence ?? null;
      for (let pages = 0; before !== null && (messages[0]?.sequence ?? 0) > afterSequence + 1 && pages < 20; pages += 1) {
        const older = await store.getAgentThread(principal, taskId, { limit, beforeSequence: before } as never);
        messages = [...(older.conversation?.messages ?? []), ...messages];
        before = older.conversation?.messagePage.nextBeforeSequence ?? null;
      }
      const after = messages.filter((message) => message.sequence > afterSequence);
      return { ...first, conversation: undefined, messages: after.slice(0, limit), nextAfterSequence: after.length > limit ? after[limit - 1]!.sequence : null };
    });
  });

  server.registerTool('flux_list_maps', { title: 'List project maps', description: 'A page of project maps. Private and direct-message maps are excluded.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal, workspaceId }) => sketchUseCases(tx).list(principal, workspaceId, { projectId, ...capped(query) })));
  server.registerTool('flux_get_map', { title: 'Read a project map',
    description: 'Read thoughts and links, up to 50 of each per page; to continue, pass the returned updatedAt as expectedUpdatedAt.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...page, linkOffset: z.int().min(0).max(10_000).default(0), expectedUpdatedAt: z.string().max(64).optional() }), annotations },
  ({ projectId, id, limit, offset, linkOffset, expectedUpdatedAt }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'sketch', id);
    return sketchUseCases(tx).getWindow(principal, id, { limit: pageLimit(limit), offset, linkOffset, expectedUpdatedAt });
  }));

  server.registerTool('flux_search_project', { title: 'Search a selected project',
    description: 'Search project content: snippets, counts and a cursor for more. Private, direct-message and person results are excluded.',
    inputSchema: z.object({ projectId: z.uuid(), q: z.string().min(1).max(200), type: z.enum(['message', 'doc', 'material', 'work', 'decision', 'result', 'sketch']).optional(),
      cursor: z.string().max(500).optional(), limit: page.limit }), annotations },
  ({ projectId, ...query }) => {
    requireMcpSourceKinds(claims, query.type ? [query.type] : ['message', 'doc', 'material', 'work', 'decision', 'result', 'sketch']);
    return result(projectId, async ({ tx, principal, workspaceId }) => {
    const access = policySearchAccess(tx);
    const search = createSearchUseCases({ rows: searchRepository(tx), cursors,
      access: { audiences: async (actor) => (await access.audiences(actor)).filter((audience) =>
        (audience.type === 'project' || audience.type === 'sketch') && audience.workspaceId === workspaceId) } });
    return search.search(principal, { ...capped(query), place: `project:${projectId}` });
    });
  });
}
