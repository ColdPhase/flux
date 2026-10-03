import type { DocWithCurrent } from '../docs/ports.js';

/** Current committed shared body; callers have authorized and locked the native doc first. */
export interface LiveDocHead {
  generation: string;
  sequence: number;
  body: string;
  hash: string;
  savedVersion: number;
  savedSequence: number;
}

/** Mandatory same-transaction boundary for every native doc writer, including standing-grant adapters. */
export interface DocLiveVersions {
  lock(docId: string): Promise<LiveDocHead | null>;
  /** A clean legacy write retires the old generation atomically; retained receipts/ownership survive. */
  rebindSaved(row: DocWithCurrent, generation: string): Promise<void>;
  /** Deliberate shared snapshot advances its saved binding without resetting text, generation or undo. */
  bindSnapshot(row: DocWithCurrent, head: LiveDocHead): Promise<DocWithCurrent>;
}
