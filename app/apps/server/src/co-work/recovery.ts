import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { CoWorkInboxRecord } from '@flux/contracts';
import { getProject, InvalidInputError, isUuid, type Database } from '@flux/core';
import { coworkRecoveryRows, type CoWorkRecoveryPosition } from '@flux/db';
import { withAgentConnection, type FluxMcpClaims } from '../agent-connection/context.js';

interface RecoveryScope { workspaceId: string; projectId: string; connectionId: string; ownerUserId: string;
  clientId: string | null; grantReferenceId: string | null }
interface Position extends CoWorkRecoveryPosition { expiresAt: number }
const PREFIX = 'cw1.', IV = 12, TAG = 16, TTL = 900_000;
const TOKEN = /^cw1\.[A-Za-z0-9_-]{40,800}$/;
/** Different key namespace from search; reconnect can resume, a foreign binding cannot. */
class RecoveryCursor {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('The recovery cursor secret must be at least32 characters');
    this.key = Buffer.from(hkdfSync('sha256', secret, 'flux-cowork-recovery', 'encryption-v1', 32));
  }
  seal(scope: RecoveryScope, position: Position) {
    const iv = randomBytes(IV), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(scope)));
    const sealed = Buffer.concat([cipher.update(JSON.stringify(position)), cipher.final()]);
    return PREFIX + Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
  }
  open(scope: RecoveryScope, token: string, now: number): Position | null {
    if (!TOKEN.test(token)) return null;
    try {
      const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
      if (raw.length <= IV + TAG) return null;
      const cipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV));
      cipher.setAAD(Buffer.from(JSON.stringify(scope))); cipher.setAuthTag(raw.subarray(raw.length - TAG));
      const value: unknown = JSON.parse(Buffer.concat([cipher.update(raw.subarray(IV, raw.length - TAG)), cipher.final()]).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const p = value as Record<string, unknown>;
      if (Object.keys(p).sort().join(',') !== 'createdAt,expiresAt,id' || typeof p.createdAt !== 'string' || p.createdAt.length > 64
        || !Number.isFinite(Date.parse(p.createdAt)) || typeof p.id !== 'string' || !isUuid(p.id)
        || !Number.isSafeInteger(p.expiresAt) || Number(p.expiresAt) <= now || Number(p.expiresAt) > now + TTL) return null;
      return p as unknown as Position;
    } catch { return null; }
  }
}

/** Bounded authorized pending references, without payer identities, fingerprints or content. */
export type CoWorkRecoveryRequest = Pick<CoWorkInboxRecord, 'id' | 'unitId' | 'taskId' | 'senderConnectionId' | 'kind' | 'target'
  | 'sourceRefs' | 'criteriaRefs' | 'state' | 'effectiveState' | 'readinessReason' | 'version' | 'reason' | 'nextBoundary'
  | 'dependencyRef' | 'responseRef' | 'expiresAt' | 'createdAt'>;
export interface CoWorkRecoveryPage { requests: CoWorkRecoveryRequest[]; continuation: string | null;
  recovery: 'snapshot' | 'continuation' | 'resync_required'; coverage: 'current_authorized_native_pending_references' }
function projectRequest(r: CoWorkInboxRecord): CoWorkRecoveryRequest {
  const { id, unitId, taskId, senderConnectionId, kind, target, sourceRefs, criteriaRefs, state, effectiveState, readinessReason,
    version, reason, nextBoundary, dependencyRef, responseRef, expiresAt, createdAt } = r;
  return { id, unitId, taskId, senderConnectionId, kind, target, sourceRefs, criteriaRefs, state, effectiveState, readinessReason,
    version, reason, nextBoundary, dependencyRef, responseRef, expiresAt, createdAt };
}

/** Internal composition for #152/#160, not a second registry or a public execution capability. */
export function coWorkRecovery(db: Database, secret: string) {
  const cursors = new RecoveryCursor(secret);
  return async (claims: FluxMcpClaims, projectId: string, query: { limit?: number; cursor?: string } = {}): Promise<CoWorkRecoveryPage> => {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || Object.keys(query).some((k) => !['limit', 'cursor'].includes(k))
      || query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 804))
      throw new InvalidInputError('A bounded recovery page and opaque continuation are required');
    // Reauthorize the actual bearer/binding, selected-project ceiling and central
    // policy BEFORE decoding any cursor or accessing the durable pending queue.
    return withAgentConnection(db, claims, 'flux.context.read', projectId, async ({ tx, connection, workspaceId, principal }) => {
      await getProject(principal, projectId, tx);
      const scope: RecoveryScope = { workspaceId, projectId, connectionId: connection.connectionId,
        ownerUserId: connection.ownerUserId, clientId: claims.clientId, grantReferenceId: claims.grantReferenceId };
      const rows = coworkRecoveryRows(tx), now = Date.now();
      const position = query.cursor === undefined ? undefined : cursors.open(scope, query.cursor, now);
      const coverage = 'current_authorized_native_pending_references' as const;
      if (position === null || position && !await rows.retained(scope, position))
        return { requests: [], continuation: null, recovery: 'resync_required', coverage };
      const page = await rows.page(scope, limit, position);
      return { requests: page.records.map(projectRequest), continuation: page.continuation
        ? cursors.seal(scope, { ...page.continuation, expiresAt: position?.expiresAt ?? now + TTL }) : null,
        recovery: position ? 'continuation' : 'snapshot', coverage };
    });
  };
}
