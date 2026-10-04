import type { MaterialSource, MessageFile } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { ActorRef, WorkAccess, WorkRepository } from '../work/ports.js';

export interface DiscussionBinding {
  workId: string;
  conversationId: string;
  rootMessageId: string;
}
/**
 * The canonical task-to-conversation identity: exactly these keys. A stored row may carry
 * more (e.g. `rootSequence`), so callers build this explicitly instead of spreading it.
 */
export type TaskDiscussionRoot = DiscussionBinding & { workspaceId: string; projectId: string };
export interface DiscussionConversation {
  id: string;
  workspaceId: string;
  projectId: string;
  createdBy: ActorRef;
  createdAt: Date;
}
/** `text` is ordinary; the others are explicit native effects (#154) and `result` names its canonical result. */
export type ContributionKind = 'text' | 'blocker' | 'result' | 'handoff';
export interface DiscussionMessage {
  id: string;
  conversationId: string;
  author: ActorRef;
  body: string;
  source: MaterialSource | null;
  sequence: number;
  projectId: string;
  clientMessageId: string;
  requestFingerprint: string;
  kind: ContributionKind;
  resultId: string | null;
  createdAt: Date;
  files?: MessageFile[];
}
export interface NewDiscussionMessage {
  /** Validated immutable attachment metadata, never supplied directly by an entry point. */
  files?: MessageFile[];
  body: string;
  clientMessageId: string;
  fingerprint: string;
  source: MaterialSource | null;
  /** Defaults to ordinary text. */
  kind?: ContributionKind;
  resultId?: string | null;
}
/** Rows only. Current access and the task identity are checked by the use case. */
export interface TaskDiscussionRepository {
  lockCommand(projectId: string, author: ActorRef, commandId: string): Promise<void>;
  existingMessage(projectId: string, author: ActorRef, commandId: string): Promise<DiscussionMessage | null>;
  findBinding(workId: string): Promise<DiscussionBinding | null>;
  findConversation(id: string): Promise<DiscussionConversation | null>;
  findMessage(id: string): Promise<DiscussionMessage | null>;
  messages(conversationId: string, window: { limit: number; beforeSequence: number | null }): Promise<DiscussionMessage[]>;
  sourceExists(projectId: string, source: MaterialSource): Promise<boolean>;
  createConversation(input: { id: string; workspaceId: string; projectId: string; createdBy: ActorRef }): Promise<DiscussionConversation>;
  append(conversation: Pick<DiscussionConversation, 'id' | 'workspaceId' | 'projectId'>, author: ActorRef, input: NewDiscussionMessage): Promise<DiscussionMessage>;
  bind(input: TaskDiscussionRoot): Promise<void>;
}
export interface TaskDiscussionEventIntent {
  readonly principal: Readonly<Principal>;
  readonly workspaceId: string;
  readonly kind: 'project.conversation_created.v1' | 'project.message_sent.v1';
  readonly objectId: string;
  readonly data: Readonly<{ conversationId: string; messageId: string; workId: string; rootMessageId: string }>;
}
export interface TaskDiscussionPorts {
  /** Human file composition. An entry point without storage must refuse attachments. */
  attachments?: { lock(projectId: string, author: ActorRef, ids: readonly string[]): Promise<MessageFile[]> };
  access: WorkAccess;
  work: Pick<WorkRepository, 'locate' | 'findWork' | 'names'>;
  discussion: TaskDiscussionRepository;
  events: {
    record(principal: Principal, workspaceId: string, kind: TaskDiscussionEventIntent['kind'],
      projectId: string, data: TaskDiscussionEventIntent['data']): Promise<void>;
  };
}
export interface TaskDiscussionUnitOfWork {
  run<T>(action: (ports: TaskDiscussionPorts) => Promise<T>): Promise<T>;
}
