import type { FastifyInstance } from 'fastify';
import { messageLinkUrls, type MessageLinkPreviews } from '@flux/contracts';
import { evaluateProject, NotFoundError, type Database } from '@flux/core';
import { accessReader, messageReferenceRows, workspaceEncryptionRows } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import type { LinkPreviewsConfig } from './config.js';
import { linkPreviews, type LinkPreviews } from './service.js';
import { CLOSED_WORLD_RULES, type FetchRules } from './safe-fetch.js';

interface Options { db: Database; sessions: SessionResolver; config: LinkPreviewsConfig; service?: LinkPreviews; rules?: FetchRules }

/**
 * Link cards (#469, F-026 §6). The server reads the addresses from the stored message, for a reader who may read its project, and
 * only then fetches: a caller never names an address, so this is not a way to make the server request something. A sealed
 * workspace never gets a fetch (its links would leave the server in the clear, which sealing exists to prevent), and neither does an
 * install whose operator has not turned previews on.
 */
export async function linkPreviewRoutes(app: FastifyInstance, { db, sessions, config, service, rules }: Options) {
  const cards = service ?? linkPreviews({ rules: rules ?? (config.testHosts.size ? CLOSED_WORLD_RULES : undefined), connectTo: config.testHosts.size ? (host) => config.testHosts.get(host) ?? null : undefined });
  app.get<{ Params: { projectId: string; messageId: string } }>('/api/v1/projects/:projectId/messages/:messageId/link-previews', async (request): Promise<MessageLinkPreviews> => {
    const { principal } = await sessions.requirePrincipal(request);
    const { projectId, messageId } = request.params;
    const evaluation = await evaluateProject(principal, 'project.read', projectId, accessReader(db));
    if (!evaluation.allowed || !evaluation.project) throw new NotFoundError('Message');
    const workspaceId = evaluation.project.workspaceId;
    // Sealed first, before the body is read: a sealed workspace's text is never opened for this route.
    if (await workspaceEncryptionRows(db).sealed(workspaceId)) return { status: 'sealed', cards: [] };
    const message = await messageReferenceRows(db).message(messageId, workspaceId);
    if (!message || message.kind !== 'project' || message.projectId !== projectId) throw new NotFoundError('Message');
    if (!config.enabled) return { status: 'off', cards: [] };
    const addresses = messageLinkUrls(message.body);
    if (!addresses.length) return { status: 'ready', cards: [] };
    const result = await cards.cards(principal.id, addresses);
    return { status: result.busy ? 'busy' : 'ready', cards: result.cards };
  });
}
