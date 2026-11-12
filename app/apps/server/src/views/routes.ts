import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CONVERSATION_VIEW_LIMITS, SPACE_SHELL_LIMITS, WORK_READ_LIMITS, projectConversationViewPath, projectSpaceShellPath,
  type ConversationView, type Page, type SpaceShell,
} from '@flux/contracts';
import { agentQuestionUseCases, conversationUseCases, DomainError, getProject, listSpacePeople, type FileStorage } from '@flux/core';
import { accessPorts, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { aiAllowedInProject } from '../access/ai-gate.js';
import { agentQuestionUnitOfWork } from '../agent-connection/agent-questions.js';
import { conversationStore } from '../conversation/store.js';
import { docUseCases } from '../docs/adapters.js';
import { scopedUpdaters } from '../docs/routes.js';
import { sketchUseCases } from '../sketches/adapters.js';
import { scopedCreators } from '../sketches/routes.js';
import { workUseCases } from '../work/adapters.js';
import { nativeWorkReadUseCases } from '../work-read/adapters.js';

interface Options { db: Database; sessions: SessionResolver; storage: FileStorage }

/**
 * A part the view can open without. A refusal that is about the place itself (a locked encrypted workspace, 423) is the whole
 * read's answer, as the part's own route would answer it; any other failure leaves the part out (`null`), as the client did when
 * it read the part on its own. A failure that is not a domain refusal is logged.
 */
async function context<T>(request: FastifyRequest, part: string, read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch (error) {
    if (error instanceof DomainError && error.status === 423) throw error;
    if (!(error instanceof DomainError)) request.log.error({ err: error, part }, 'a part of a view read failed');
    return null;
  }
}

/** What a refusal about the place itself is: the space is not the person's (any more), or its workspace is locked. */
const ACCESS = new Set([401, 403, 404, 410, 423]);

/**
 * The announcements beside the roots: a failure that is not about access leaves the stream readable without them, as when the
 * client read them on their own.
 */
async function announcements<T>(request: FastifyRequest, part: string, read: () => Promise<Page<T>>): Promise<Page<T>> {
  try { return await read(); } catch (error) {
    if (error instanceof DomainError && ACCESS.has(error.status)) throw error;
    request.log.error({ err: error, part }, 'a part of a view read failed');
    return { items: [], total: 0, limit: CONVERSATION_VIEW_LIMITS.notices, offset: 0 };
  }
}

/**
 * One read per screen (#1109): the space's frame (`space-shell`) and its Conversation (`conversation-view`). Each part is the same
 * use case its own route calls, with the caller's principal, so each part checks access as it does on its own; nothing here reads
 * a table. The parts are read beside each other.
 */
export async function viewRoutes(app: FastifyInstance, { db, sessions, storage }: Options) {
  useDomainErrors(app);
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'private, no-store'); });
  const conversations = conversationUseCases(conversationStore(db, { storage }));
  const work = workUseCases(db);
  const docs = docUseCases(db);
  const sketches = sketchUseCases(db);
  const questions = agentQuestionUseCases(agentQuestionUnitOfWork(db));

  app.get<{ Params: { projectId: string } }>(projectSpaceShellPath(':projectId'), async (request): Promise<SpaceShell> => {
    const session = await sessions.requirePrincipal(request);
    const { principal } = session;
    // The space first: its refusal is the read's answer (#592), and the parts below are read only for a space the person opens.
    const project = await getProject(principal, request.params.projectId, db, accessPorts);
    const reads = nativeWorkReadUseCases(db, sessions, session, request.headers);
    const [people, sketchPage, docPage, workSummary] = await Promise.all([
      context(request, 'people', () => listSpacePeople(principal, project.id, db, accessPorts)),
      context(request, 'sketches', async () => scopedCreators(db, project.workspaceId,
        await sketches.list(principal, project.workspaceId, { limit: SPACE_SHELL_LIMITS.sketches, offset: 0, projectId: project.id, hideEmpty: true }))),
      context(request, 'docs', async () => {
        const found = await docs.listProjectDocs(principal, project.id, { limit: SPACE_SHELL_LIMITS.docs, offset: 0 });
        return { ...found, items: await scopedUpdaters(db, found.items) };
      }),
      context(request, 'work summary', () => reads.summary(principal, project.id)),
    ]);
    return { project, people, sketches: sketchPage, docs: docPage, workSummary };
  });

  app.get<{ Params: { projectId: string } }>(projectConversationViewPath(':projectId'), async (request): Promise<ConversationView> => {
    const session = await sessions.requirePrincipal(request);
    const { principal } = session;
    const { projectId } = request.params;
    // The roots first: they check that the person opens the space, and the associations are read for their messages.
    const roots = await conversations.listRoots(principal, projectId, {});
    const messageIds = [...new Set(roots.roots.slice(-WORK_READ_LIMITS.sourceIds).map((root) => root.message.id))].sort();
    const reads = nativeWorkReadUseCases(db, sessions, session, request.headers);
    const [taskNotices, objectNotices, materials, agentQuestions, workAssociations] = await Promise.all([
      announcements(request, 'task notices', () => work.listTaskNotices(principal, roots.projectId, { limit: CONVERSATION_VIEW_LIMITS.notices, offset: 0 })),
      announcements(request, 'object notices', () => work.listObjectNotices(principal, roots.projectId, { limit: CONVERSATION_VIEW_LIMITS.notices, offset: 0 })),
      conversations.listMaterials(principal, roots.projectId, { limit: CONVERSATION_VIEW_LIMITS.materials, offset: 0 }),
      // AG-10: while the space's AI is off its questions route refuses; the view leaves them out.
      context(request, 'agent questions', async () => await aiAllowedInProject(db, roots.projectId) ? questions.list(principal, roots.projectId) : null),
      messageIds.length ? context(request, 'work associations', () => reads.associations(principal, roots.projectId,
        new URLSearchParams({ relation: 'source', limit: String(WORK_READ_LIMITS.defaultPage), messageIds: messageIds.join(',') }))) : null,
    ]);
    return { projectId: roots.projectId, roots, taskNotices, objectNotices, materials, agentQuestions, workAssociations };
  });
}
