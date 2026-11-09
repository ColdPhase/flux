import type { AgentProjectOwner, MaterialSource, MessageFile, MessageReference, MessageReferenceCard } from '@flux/contracts';
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
  /** The page it cited was deleted (#941). */
  sourceDeleted?: boolean;
  sequence: number;
  projectId: string;
  clientMessageId: string;
  requestFingerprint: string;
  kind: ContributionKind;
  resultId: string | null;
  createdAt: Date;
  files?: MessageFile[];
  /** The agent whose answer the author posted with Show everyone (#842). */
  via?: string | null;
  /** When the author deleted it (#1006): the words are the marker and the request fingerprint no longer digests what was sent. */
  removedAt?: Date | null;
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
  /**
   * A line Flux itself writes for an agent: an in-app agent's run report, its question to another agent, the answer, or a status line
   * ("Stopped by Maja", "This needs a person"). Those are bounded by the run and by TA-3, so the five-in-a-row limit neither counts
   * nor refuses them (C-51). Only the server's agent-task drain sets it; no entry point a client reaches does.
   */
  byFlux?: boolean;
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
  /** The task whose discussion this conversation is, or null for any other conversation of the space. */
  taskOf(conversationId: string): Promise<string | null>;
  /**
   * How many agent messages (at most `limit`) the conversation has had since a person last wrote in it. Lines Flux wrote for an agent
   * (`byFlux`) are skipped: they neither count nor end the run.
   */
  trailingAgentMessages(conversationId: string, limit: number): Promise<number>;
  createConversation(input: { id: string; workspaceId: string; projectId: string; createdBy: ActorRef }): Promise<DiscussionConversation>;
  append(conversation: Pick<DiscussionConversation, 'id' | 'workspaceId' | 'projectId'>, author: ActorRef, input: NewDiscussionMessage): Promise<DiscussionMessage>;
  bind(input: TaskDiscussionRoot): Promise<void>;
  /** Canonical file publication after the actual task binding exists; uses the caller's complete retained fence. */
  publishFiles?(scope:{workspaceId:string;projectId:string},messageId:string,
    retained:{readonly ids:readonly string[];mark(ids?:readonly string[]):Promise<void>}):Promise<void>;
}
export interface TaskDiscussionEventIntent {
  readonly principal: Readonly<Principal>;
  readonly workspaceId: string;
  readonly kind: 'project.conversation_created.v1' | 'project.message_sent.v1';
  readonly objectId: string;
  readonly data: Readonly<{ conversationId: string; messageId: string; workId: string; rootMessageId: string }>;
}
export interface TaskDiscussionPorts {
  /** Read-only display metadata for actual historical authors; no grant or stored-author mutation. */
  authorOwners?: { read(projectId: string, workspaceId: string, agentIds: readonly string[]): Promise<ReadonlyMap<string, AgentProjectOwner>> };
  /** Human file composition. An entry point without storage must refuse attachments. */
  attachments?: { lock(projectId: string, author: ActorRef, ids: readonly string[]): Promise<MessageFile[]> };
  /** What a contribution cites (#469): the same rules and the same policy as a conversation message's references. An entry point without it must refuse them. */
  references?: {
    assertReadable(principal: Principal, workspaceId: string, references: readonly MessageReference[]): Promise<void>;
    save(messageId: string, workspaceId: string, references: readonly MessageReference[]): Promise<void>;
    cards(principal: Principal, workspaceId: string, messageIds: readonly string[]): Promise<Map<string, MessageReferenceCard[]>>;
  };
  access: WorkAccess;
  work: Pick<WorkRepository, 'locate' | 'findWork' | 'names' | 'prepareTaskUse'>;
  discussion: TaskDiscussionRepository;
  events: {
    record(principal: Principal, workspaceId: string, kind: TaskDiscussionEventIntent['kind'],
      projectId: string, data: TaskDiscussionEventIntent['data']): Promise<void>;
  };
}
export interface TaskDiscussionUnitOfWork {
  run<T>(action: (ports: TaskDiscussionPorts) => Promise<T>): Promise<T>;
}
