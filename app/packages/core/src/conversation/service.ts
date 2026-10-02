import type {
  Conversation, ConversationMessage, ConversationRootQuery, ConversationRootWindow, ConversationSummary, ConversationWindowQuery,
  CreateMaterialCommand, Material, MaterialVersion, Page, PageQuery, SendMessageCommand, UpdateMaterialCommand,
} from '@flux/contracts';
import type { Principal } from '../types.js';
import { normalizeConversationWindow, normalizeMaterial, normalizeMaterialUpdate, normalizeMessage, normalizeRootWindow } from './commands.js';

/** Storage and current-access boundary. The adapter must authorize before every read and
 * authorize under the write transaction before every mutation or idempotent replay. */
export interface ConversationPort {
  listConversations(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<ConversationSummary>>;
  /** The project's one stream (UI116-1): authorize the project first, then count and page its roots. */
  listRoots(principal: Principal, projectId: string, window: ReturnType<typeof normalizeRootWindow>): Promise<ConversationRootWindow>;
  getConversation(principal: Principal, conversationId: string, window: ReturnType<typeof normalizeConversationWindow>): Promise<Conversation>;
  createConversation(principal: Principal, projectId: string, input: ReturnType<typeof normalizeMessage>): Promise<Conversation>;
  sendMessage(principal: Principal, conversationId: string, input: ReturnType<typeof normalizeMessage>): Promise<ConversationMessage>;
  listMaterials(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<Material>>;
  getMaterial(principal: Principal, materialId: string): Promise<Material>;
  getMaterialVersion(principal: Principal, materialId: string, version: number): Promise<MaterialVersion>;
  createMaterial(principal: Principal, projectId: string, input: ReturnType<typeof normalizeMaterial>): Promise<Material>;
  updateMaterial(principal: Principal, materialId: string, input: ReturnType<typeof normalizeMaterialUpdate>): Promise<Material>;
}

/** HTTP and future entry points share command rules; the adapter owns persistence and locks. */
export function conversationUseCases(port: ConversationPort) {
  return {
    listConversations: (principal: Principal, projectId: string, query?: PageQuery) => port.listConversations(principal, projectId, query),
    listRoots: (principal: Principal, projectId: string, query?: ConversationRootQuery) =>
      port.listRoots(principal, projectId, normalizeRootWindow(query)),
    getConversation: (principal: Principal, conversationId: string, query?: ConversationWindowQuery) =>
      port.getConversation(principal, conversationId, normalizeConversationWindow(query)),
    createConversation: (principal: Principal, projectId: string, command: SendMessageCommand) =>
      port.createConversation(principal, projectId, normalizeMessage(command)),
    sendMessage: (principal: Principal, conversationId: string, command: SendMessageCommand) =>
      port.sendMessage(principal, conversationId, normalizeMessage(command)),
    listMaterials: (principal: Principal, projectId: string, query?: PageQuery) => port.listMaterials(principal, projectId, query),
    getMaterial: (principal: Principal, materialId: string) => port.getMaterial(principal, materialId),
    getMaterialVersion: (principal: Principal, materialId: string, version: number) => port.getMaterialVersion(principal, materialId, version),
    createMaterial: (principal: Principal, projectId: string, command: CreateMaterialCommand) =>
      port.createMaterial(principal, projectId, normalizeMaterial(command)),
    updateMaterial: (principal: Principal, materialId: string, command: UpdateMaterialCommand) =>
      port.updateMaterial(principal, materialId, normalizeMaterialUpdate(command)),
  };
}
