import type { PinnedMessage, PinPart, PinPlace } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of pinned messages (C-74, #1615). Core states what it needs; the server implements it with the access policy and the `@flux/db`
 * rows (`apps/server/src/pins/adapters.ts`).
 */

/** The message a pin names, as the repository found it in its conversation; opaque to core. */
export type PinTargetRef = { readonly messageId: string };

export interface PinAccess {
  /**
   * The conversation's workspace when the principal may read it (`read`) or write in it now (`write`: its access rows held while the change
   * is made, so a person removed or made a reader meanwhile changes nothing). Throws the policy's 404 or 403 otherwise.
   */
  require(principal: Principal, place: PinPlace, action: 'read' | 'write'): Promise<{ workspaceId: string; ownerUserId?: string }>;
}

export interface PinRepository {
  target(place: PinPlace, workspaceId: string, messageId: string, part: PinPart | null): Promise<PinTargetRef | null>;
  pin(target: PinTargetRef, pinnedBy: string): Promise<boolean>;
  unpin(target: PinTargetRef): Promise<boolean>;
  list(place: PinPlace, workspaceId: string, limit: number): Promise<(PinnedMessage & { sources?: number })[]>;
}

export interface PinPorts {
  access: PinAccess;
  pins: PinRepository;
  events: { record(principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>): Promise<void> };
}

export interface PinUnitOfWork { run<T>(work: (ports: PinPorts) => Promise<T>): Promise<T> }
