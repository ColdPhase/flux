import type { Principal } from '../principal.js';
import type { SketchRecord, ThoughtRecord, LinkRecord } from '../sketches/ports.js';

/** Internal link epoch is monotonic across deletion/restoration even though native wire links have no version. */
export interface MapJournalLink extends LinkRecord { epoch: number; createdBy: { kind: 'human' | 'agent'; id: string } }
export interface MapNativeChange extends Record<string, unknown> {
  sketchBefore: SketchRecord | null; sketchAfter: SketchRecord | null;
  thoughts: { id: string; before: ThoughtRecord | null; after: ThoughtRecord | null }[];
  links: { id: string; before: MapJournalLink | null; after: MapJournalLink | null }[];
  dependencies: { thoughtId: string; before: { id: string; epoch: number }[]; after: { id: string; epoch: number }[] }[];
  removedThoughts: { id: string; version: number }[];
  clearedLeaseIds: string[];
}
export interface SketchLiveJournal {
  /** Native CAS/policy has already succeeded; capture affected raw rows and dependency bags before any mutation. */
  before(principal: Principal, sketch: SketchRecord, affected: {
    thoughtIds: string[]; linkIds: string[]; sketch?: boolean; leaseId?: string;
  }): Promise<void>;
  /** Same transaction as native rows and ordinary event; immutable command receipt and identifier-only NOTIFY. */
  commit(principal: Principal, sketch: SketchRecord): Promise<void>;
}
