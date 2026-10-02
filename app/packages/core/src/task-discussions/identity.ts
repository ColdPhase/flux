import { createHash } from 'node:crypto';
import type { MessageContribution } from '@flux/contracts';
import type { ContributionAnchor, ContributionDraft } from '../work/ports.js';
import type { ContributionKind } from './ports.js';

/** A deterministic, lower-case UUID (version 5 layout) of a SHA-256 digest of the parts. */
export function derivedUuid(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(parts.join('\u0000')).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The message command identity of one explicit effect on one task: derived from the stable domain command
 * (or the canonical result) plus the exact task, so every retry computes the same identity. The fingerprint
 * pins the operation, task, anchor and exact authored text, so a reused identity cannot mean another effect.
 */
export function contributionIdentity(anchor: ContributionAnchor, draft: ContributionDraft) {
  const anchorId = anchor.operation === 'result.create' ? anchor.resultId : anchor.commandId;
  return {
    clientMessageId: derivedUuid('flux.task-contribution.v1', anchor.operation, anchorId.toLowerCase(), draft.workId.toLowerCase()),
    fingerprint: createHash('sha256').update(JSON.stringify({ operation: `task.${draft.kind}`, workId: draft.workId.toLowerCase(),
      anchor: anchorId.toLowerCase(), body: draft.body, resultId: draft.resultId?.toLowerCase() ?? null })).digest('hex'),
  };
}

/** The wire marker of a stored message: absent for ordinary text, so existing human JSON is unchanged. */
export function messageContribution(kind: ContributionKind, resultId: string | null): MessageContribution | undefined {
  if (kind === 'text') return undefined;
  if (kind === 'result') {
    if (!resultId) throw new Error('Stored result contribution lacks its result');
    return { kind, resultId };
  }
  return { kind };
}
