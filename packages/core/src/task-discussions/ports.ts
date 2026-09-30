import type { ConversationMessage, MaterialSource } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { WorkAccess, WorkRepository } from '../work/ports.js';

export interface DiscussionBinding {
  workId: string;
  conversationId: string;
  rootMessageId: string;
}
export interface DiscussionConversation {
  id: string;
  workspaceId: string;
  projectId: string;
  createdBy: string;
  createdAt: Date;
}
export interface DiscussionMessage extends Omit<ConversationMessage, 'createdAt'> {
  projectId: string;
  clientMessageId: string;
  requestFingerprint: string;
  createdAt: Date;
}
export interface NewDiscussionMessage {
  body: string;
  clientMessageId: string;
  fingerprint: string;
  source: MaterialSource | null;
}
/** Rows only. Current access and the task identity are checked by the use case. */
export interface TaskDiscussionRepository {
  lockCommand(projectId: string, authorId: string, commandId: string): Promise<void>;
  existingMessage(projectId: string, authorId: string, commandId: string): Promise<DiscussionMessage | null>;
  findBinding(workId: string): Promise<DiscussionBinding | null>;
  findConversation(id: string): Promise<DiscussionConversation | null>;
  findMessage(id: string): Promise<DiscussionMessage | null>;
  messages(conversationId: string, window: { limit: number; beforeSequence: number | null }): Promise<DiscussionMessage[]>;
  sourceExists(projectId: string, source: MaterialSource): Promise<boolean>;
  createConversation(input: { id: string; workspaceId: string; projectId: string; createdBy: string }): Promise<DiscussionConversation>;
  append(conversation: DiscussionConversation, authorId: string, input: NewDiscussionMessage): Promise<DiscussionMessage>;
  bind(input: DiscussionBinding & { workspaceId: string; projectId: string }): Promise<void>;
}
export interface TaskDiscussionPorts {
  access: WorkAccess;
  work: Pick<WorkRepository, 'locate' | 'findWork'>;
  discussion: TaskDiscussionRepository;
  events: {
    record(principal: Principal, workspaceId: string, kind: 'project.conversation_created.v1' | 'project.message_sent.v1',
      projectId: string, data: Record<string, unknown>): Promise<void>;
  };
}
export interface TaskDiscussionUnitOfWork {
  run<T>(action: (ports: TaskDiscussionPorts) => Promise<T>): Promise<T>;
}
