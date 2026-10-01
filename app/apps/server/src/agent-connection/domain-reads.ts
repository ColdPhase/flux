import type { AgentToolRegistrar } from './tool-registry.js';
import { z } from 'zod';
import { conversationUseCases, createSearchUseCases, DomainError, getProject, type Database } from '@flux/core';
import { conversationStore } from '../conversation/store.js';
import { docUseCases } from '../docs/adapters.js';
import { workUseCases } from '../work/adapters.js';
import { sketchUseCases } from '../sketches/adapters.js';
import { policySearchAccess, searchRepository } from '../search/adapters.js';
import { SearchCursorCodec } from '../search/cursor.js';
import { withAgentConnection, type FluxMcpClaims } from './context.js';
import { toolError, toolResult } from './tool-results.js';

const page = { limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10_000).default(0) };
const projectPage = z.object({ projectId: z.uuid(), ...page });
const object = z.object({ projectId: z.uuid(), id: z.uuid() });
const chunk = { offset: z.int().min(0).max(100_000).default(0), version: z.int().min(1).optional() };
const TEXT_CHUNK = 20_000;
const annotations = { readOnlyHint: true };

/** Chunking always reports coverage; a continuation cannot silently switch source versions. */
function textChunk(body: string, version: number, offset: number, expected?: number) {
  if (offset > 0 && expected === undefined)
    throw new DomainError(400, 'VERSION_REQUIRED', 'A continuation needs the source version from the first page');
  if (expected !== undefined && version !== expected)
    throw new DomainError(409, 'SOURCE_VERSION_CONFLICT', 'The source changed; read it again from the first page');
  return { body: body.slice(offset, offset + TEXT_CHUNK), offset, totalLength: body.length,
    nextOffset: offset + TEXT_CHUNK < body.length ? offset + TEXT_CHUNK : null };
}

/** Canonical readers under the selected-project ceiling. No separate MCP object model. */
export function registerAgentDomainReads(server: AgentToolRegistrar, db: Database, claims: FluxMcpClaims, cursorSecret: string) {
  const cursors = new SearchCursorCodec(cursorSecret);
  async function result<T>(projectId: string | null, read: Parameters<typeof withAgentConnection<T>>[4]) {
    try { return toolResult(await withAgentConnection(db, claims, 'flux.context.read', projectId, read)); }
    catch (error) { return toolError(error); }
  }

  server.registerTool('flux_list_contexts', { title: 'List selected Flux projects',
    description: 'List the selected projects still readable by this current connection.', inputSchema: z.object({}), annotations },
  () => result(null, async ({ tx, connection, principal }) => ({ projects: await Promise.all(connection.selectedProjectIds.map(async (id) => {
    const project = await getProject(principal, id, tx);
    return { id: project.id, name: project.name, workspaceId: project.workspaceId };
  })) })));

  server.registerTool('flux_list_materials', { title: 'List project sources',
    description: 'A bounded page of current material and wiki IDs, titles and versions. No private draft provenance.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, async ({ tx, principal }) =>
    ({ projectId, ...await conversationStore(tx).listSourceMaterials(principal, projectId, query) })));

  server.registerTool('flux_read_material', { title: 'Read a project material',
    description: 'Read current source text in explicit 20,000-character pages. Continue with nextOffset and this exact version.',
    inputSchema: z.object({ projectId: z.uuid(), materialId: z.uuid(), ...chunk }), annotations },
  ({ projectId, materialId, offset, version }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'material', materialId);
    const material = await conversationStore(tx).getMaterial(principal, materialId);
    return { projectId, materialId: material.materialId, version: material.version, title: material.title,
      url: material.url, updatedAt: material.updatedAt, ...textChunk(material.body, material.version, offset, version) };
  }));

  server.registerTool('flux_list_work', { title: 'List native project tasks',
    description: 'A bounded page of the same tasks shown in the project board, including current versions and links.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listWork(principal, projectId, query)));
  server.registerTool('flux_get_work', { title: 'Read a native task', description: 'Read one current task in the selected project.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'work', id); return workUseCases(tx).getWork(principal, id);
  }));
  server.registerTool('flux_list_decisions', { title: 'List project decisions', description: 'A bounded page of proposed, accepted and superseded decisions.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listDecisions(principal, projectId, query)));
  server.registerTool('flux_get_decision', { title: 'Read a project decision', description: 'Read one current decision, its actual authors and status.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'decision', id); return workUseCases(tx).getDecision(principal, id);
  }));
  server.registerTool('flux_list_results', { title: 'List project results', description: 'A bounded page of canonical positive and negative results.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => workUseCases(tx).listResults(principal, projectId, query)));
  server.registerTool('flux_get_result', { title: 'Read a project result', description: 'Read one immutable result and its source links.',
    inputSchema: object, annotations }, ({ projectId, id }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'result', id); return workUseCases(tx).getResult(principal, id);
  }));

  server.registerTool('flux_list_docs', { title: 'List project wiki', description: 'A bounded page of wiki titles, versions and publication states.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => docUseCases(tx).listProjectDocs(principal, projectId, query)));
  server.registerTool('flux_get_doc', { title: 'Read project wiki text',
    description: 'Read a current wiki document in explicit 20,000-character pages. Continue with nextOffset and this exact version.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...chunk }), annotations },
  ({ projectId, id, offset, version }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'doc', id);
    const { body, html: _html, ...doc } = await docUseCases(tx).getDoc(principal, id);
    void _html;
    return { ...doc, ...textChunk(body, doc.version, offset, version) };
  }));

  server.registerTool('flux_list_conversations', { title: 'List project conversations', description: 'A bounded page of canonical project discussions.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal }) => conversationUseCases(conversationStore(tx)).listConversations(principal, projectId, query)));
  server.registerTool('flux_get_conversation', { title: 'Read a project conversation',
    description: 'Read at most 50 canonical messages. Use nextBeforeSequence for older contributions.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), limit: z.int().min(1).max(50).default(20), beforeSequence: z.int().min(1).optional() }), annotations },
  ({ projectId, id, ...query }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'conversation', id);
    return conversationUseCases(conversationStore(tx)).getConversation(principal, id, query);
  }));

  server.registerTool('flux_list_maps', { title: 'List project maps', description: 'A bounded page of project maps. Private and direct-message maps are excluded.',
    inputSchema: projectPage, annotations }, ({ projectId, ...query }) => result(projectId, ({ tx, principal, workspaceId }) => sketchUseCases(tx).list(principal, workspaceId, { projectId, ...query })));
  server.registerTool('flux_get_map', { title: 'Read a project map',
    description: 'Read paged thoughts and links, each at most 50. Continuations require the returned updatedAt checkpoint.',
    inputSchema: z.object({ projectId: z.uuid(), id: z.uuid(), ...page, linkOffset: z.int().min(0).max(10_000).default(0), expectedUpdatedAt: z.string().max(64).optional() }), annotations },
  ({ projectId, id, limit, offset, linkOffset, expectedUpdatedAt }) => result(projectId, async ({ tx, principal, requireObject }) => {
    await requireObject(projectId, 'sketch', id);
    return sketchUseCases(tx).getWindow(principal, id, { limit, offset, linkOffset, expectedUpdatedAt });
  }));

  server.registerTool('flux_search_project', { title: 'Search a selected project',
    description: 'Search canonical project content with bounded snippets, counts and an authenticated continuation. Private, direct-message and person results are excluded.',
    inputSchema: z.object({ projectId: z.uuid(), q: z.string().min(1).max(200), type: z.enum(['message', 'doc', 'material', 'work', 'decision', 'result', 'sketch']).optional(),
      cursor: z.string().max(500).optional(), limit: page.limit }), annotations },
  ({ projectId, ...query }) => result(projectId, async ({ tx, principal, workspaceId }) => {
    const access = policySearchAccess(tx);
    const search = createSearchUseCases({ rows: searchRepository(tx), cursors,
      access: { audiences: async (actor) => (await access.audiences(actor)).filter((audience) =>
        (audience.type === 'project' || audience.type === 'sketch') && audience.workspaceId === workspaceId) } });
    return search.search(principal, { ...query, place: `project:${projectId}` });
  }));
}
