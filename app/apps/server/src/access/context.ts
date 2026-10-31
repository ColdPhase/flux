import type { PgBoss } from 'pg-boss';
import type { InviteSigner, ProcessKeys, ResourceRef } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner } from '../http/commands.js';
import { withNoMediaAccessChange, type LiveRevocationCoordinator } from '../live/revocation.js';

export interface AccessRouteOptions {
  db: Database;
  sessions: SessionResolver;
  boss: Pick<PgBoss, 'send'>;
  liveRevocation?: LiveRevocationCoordinator | null;
  /** With a sign-on provider configured, adding a member by email finds only a verified address (F-024 S5a, #313). */
  verifiedEmailMembers?: boolean;
  /** F-030: this process's keys, so a workspace's `encryption.state` uses this API's keyring boot. */
  encryptionKeys?: ProcessKeys;
  /** F-035: signs and finds invite links (the identity secret and the public origin). Without it no invite route is registered. */
  inviteSigner?: InviteSigner;
}

/**
 * What every access route module shares (#85): the session's principal, the command runner, the
 * idempotency scopes, and the media fences around membership and grant changes.
 */
export function accessContext({ db, sessions, liveRevocation, verifiedEmailMembers = false, encryptionKeys }: AccessRouteOptions) {
  const workspaceChange = <T>(id: string, mutation: (connection: Database) => Promise<T>): Promise<T> => {
    if (liveRevocation) return liveRevocation.withWorkspaceChange(id, () => mutation(db));
    return withNoMediaAccessChange(db, { workspaceId: id, projectId: null }, mutation);
  };
  const projectChange = <T>(id: string, mutation: (connection: Database) => Promise<T>): Promise<T> => {
    if (liveRevocation) return liveRevocation.withProjectChange(id, () => mutation(db));
    return withNoMediaAccessChange(db, { workspaceId: '', projectId: id }, mutation);
  };
  return {
    db,
    sessions,
    verifiedEmailMembers,
    /** How this API reads a workspace's encryption state: its keyring boot (null while unreachable), or rows only. */
    readOptions: () => (encryptionKeys ? { bootId: encryptionKeys.openableBoot } : {}),
    ...commandRunner(db, sessions),
    workspaceScope: (id: string): ResourceRef => ({ type: 'workspace', id }),
    projectScope: (id: string): ResourceRef => ({ type: 'project', id }),
    draftScope: (id: string): ResourceRef => ({ type: 'draft', id }),
    workspaceChange,
    projectChange,
  };
}

export type AccessContext = ReturnType<typeof accessContext>;
