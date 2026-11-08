import type {
  Conversation, ConversationMessage, ConversationRootQuery, ConversationRootWindow, ConversationSummary, ConversationWindowQuery,
  CreateMaterialCommand, EditMessageCommand, Material, MaterialOrDoc, MaterialVersion, Page, PageQuery, SendMessageCommand, UpdateMaterialCommand,
} from '@flux/contracts';
import type { Principal } from '../types.js';
import { normalizeConversationWindow, normalizeMaterial, normalizeMaterialUpdate, normalizeMessage, normalizeMessageEdit, normalizeRootWindow } from './commands.js';

/** Show everyone (#842): the agent whose answer a person posts as their own message, "Ada · via Assistant". Only the server sets it, from the answer itself. */
export interface ViaAgent { via?: string | null }

/** Storage and current-access boundary. The adapter must authorize before every read and
 * authorize under the write transaction before every mutation or idempotent replay. */
export interface ConversationPort {
  listConversations(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<ConversationSummary>>;
  /** The project's one stream (UI116-1): authorize the project first, then count and page its roots. */
  listRoots(principal: Principal, projectId: string, window: ReturnType<typeof normalizeRootWindow>): Promise<ConversationRootWindow>;
  getConversation(principal: Principal, conversationId: string, window: ReturnType<typeof normalizeConversationWindow>): Promise<Conversation>;
  createConversation(principal: Principal, projectId: string, input: ReturnType<typeof normalizeMessage> & ViaAgent): Promise<Conversation>;
  sendMessage(principal: Principal, conversationId: string, input: ReturnType<typeof normalizeMessage> & ViaAgent): Promise<ConversationMessage>;
  /** The author changes the words of their own message in place (#1006); only the author, with write access, on a plain message. */
  editMessage(principal: Principal, conversationId: string, messageId: string, input: ReturnType<typeof normalizeMessageEdit>): Promise<ConversationMessage>;
  /** The author deletes their own message (#1006): a marker stays in its place; the words, its files and its notices go. */
  removeMessage(principal: Principal, conversationId: string, messageId: string): Promise<ConversationMessage>;
  listMaterials(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<Material>>;
  /** Any material or doc by ID; a doc's current version may be agent-written (#152). */
  getMaterial(principal: Principal, materialId: string): Promise<MaterialOrDoc>;
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
    createConversation: (principal: Principal, projectId: string, command: SendMessageCommand, via?: string) =>
      port.createConversation(principal, projectId, { ...normalizeMessage(command), via: via ?? null }),
    sendMessage: (principal: Principal, conversationId: string, command: SendMessageCommand, via?: string) =>
      port.sendMessage(principal, conversationId, { ...normalizeMessage(command), via: via ?? null }),
    editMessage: (principal: Principal, conversationId: string, messageId: string, command: EditMessageCommand) =>
      port.editMessage(principal, conversationId, messageId, normalizeMessageEdit(command)),
    removeMessage: (principal: Principal, conversationId: string, messageId: string) => port.removeMessage(principal, conversationId, messageId),
    listMaterials: (principal: Principal, projectId: string, query?: PageQuery) => port.listMaterials(principal, projectId, query),
    getMaterial: (principal: Principal, materialId: string) => port.getMaterial(principal, materialId),
    getMaterialVersion: (principal: Principal, materialId: string, version: number) => port.getMaterialVersion(principal, materialId, version),
    createMaterial: (principal: Principal, projectId: string, command: CreateMaterialCommand) =>
      port.createMaterial(principal, projectId, normalizeMaterial(command)),
    updateMaterial: (principal: Principal, materialId: string, command: UpdateMaterialCommand) =>
      port.updateMaterial(principal, materialId, normalizeMaterialUpdate(command)),
  };
}
