import { createHash } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { docRows } from './docs.js';
import type { DbExecutor } from './push.js';

// Rows only, on the caller's open transaction. Core has already locked current
// authorization and the native material; every live writer uses the same order.
type Head = typeof schema.docLiveHeads.$inferSelect;
type SavedDoc = NonNullable<Awaited<ReturnType<ReturnType<typeof docRows>['find']>>>;
const heads = schema.docLiveHeads;
const snapshots = schema.docLiveSnapshots;
const updates = schema.docLiveUpdates;
const hash = (body: string) => createHash('sha256').update(body).digest('hex');

export function docLiveVersions(db: DbExecutor) {
  const docs = docRows(db);
  async function locked(docId: string) {
    const [head] = await db.select().from(heads).where(eq(heads.docId, docId)).for('update');
    return head ?? null;
  }
  return {
    async lock(docId: string) {
      const head = await locked(docId);
      return head ? { generation: head.generation, sequence: head.sequence, body: head.body, hash: head.hash,
        savedVersion: head.savedVersion, savedSequence: head.savedSequence } : null;
    },
    async rebindSaved(row: SavedDoc, generation: string) {
      const old = await locked(row.doc.id);
      if (!old) return; // An ordinary doc need not have opened a shared editing room.
      const saved = await docs.version(row.doc.id, old.savedVersion);
      if (old.savedVersion !== row.doc.currentVersion - 1 || old.body !== saved?.body) {
        throw new Error('Dirty shared head cannot be rebound by a native writer');
      }
      // The retired generation's state is its snapshot plus its still retained update log.
      await db.insert(schema.docLiveArchives).values({ docId: old.docId, generation: old.generation, sequence: old.sequence,
        body: old.body, hash: old.hash, savedVersion: old.savedVersion, savedSequence: old.savedSequence, codecState: old.codecState,
        snapshotSequence: old.codecState ? old.snapshotSequence : null });
      await db.update(heads).set({ generation, sequence: 0, body: row.current.body, hash: hash(row.current.body),
        savedVersion: row.current.version, savedSequence: 0, codecState: null, snapshotSequence: 0, revision: sql`${heads.revision} + 1`,
        updatedAt: new Date() }).where(eq(heads.docId, row.doc.id));
    },
    async bindSnapshot(row: SavedDoc, acknowledged: Pick<Head, 'generation' | 'sequence' | 'body' | 'hash' | 'savedVersion' | 'savedSequence'>) {
      const current = await locked(row.doc.id);
      if (!current || current.generation !== acknowledged.generation || current.sequence !== acknowledged.sequence
        || current.hash !== acknowledged.hash || current.body !== acknowledged.body || current.savedSequence !== acknowledged.savedSequence
        || current.savedVersion !== acknowledged.savedVersion || current.savedVersion !== row.current.version - 1
        || row.current.body !== current.body || hash(current.body) !== current.hash) {
        throw new Error('Snapshot must bind exactly the locked shared head');
      }
      const contributors = await db.selectDistinct({ id: updates.actorId }).from(updates).where(and(
        eq(updates.docId, row.doc.id), eq(updates.generation, current.generation),
        gt(updates.sequence, current.savedSequence), lte(updates.sequence, current.sequence),
      )).orderBy(updates.actorId);
      await db.insert(snapshots).values({ docId: row.doc.id, version: row.current.version,
        workspaceId: row.doc.workspaceId, projectId: row.doc.projectId, generation: current.generation,
        fromSequence: current.savedSequence, toSequence: current.sequence, hash: current.hash,
        contributors: contributors.map(({ id }) => ({ kind: 'human' as const, id })) });
      // Retain the complete CRDT/ownership/undo generation; only its saved binding changes.
      await db.update(heads).set({ savedVersion: row.current.version, savedSequence: current.sequence, updatedAt: new Date() })
        .where(eq(heads.docId, row.doc.id));
      return (await docs.find(row.doc.id))!;
    },
  };
}
