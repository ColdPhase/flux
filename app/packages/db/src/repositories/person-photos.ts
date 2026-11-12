import { eq, or, sql } from 'drizzle-orm';
import type { PictureSize } from '@flux/contracts';
import * as schema from '../schema.js';
import { personSeenBySql } from './access.js';
import type { DbExecutor } from './push.js';

const p = schema.personPhotos;

/** Core's `PersonPhotoRow` (F-039); `personPhotoRows` implements core's `PersonPhotoRepository` structurally. */
export interface PersonPhotoRecord { id: string; userId: string; objects: Record<PictureSize, string> }

const rowOf = (row: typeof p.$inferSelect): PersonPhotoRecord => ({
  id: row.id, userId: row.userId, objects: { 64: row.object64, 128: row.object128, 256: row.object256 },
});

/**
 * Profile photos (F-039, #1226). Every method runs in the caller's transaction. Deleting a row queues its objects in `file_garbage`
 * (trigger `person_photo_garbage`), so the bytes leave the disk with the next files sweep.
 */
export function personPhotoRows(db: DbExecutor) {
  return {
    async replace(row: PersonPhotoRecord): Promise<void> {
      // The account row serializes two uploads of one person (FOR NO KEY UPDATE still lets the photo's foreign key check share it).
      await db.execute(sql`SELECT 1 FROM auth_users WHERE id = ${row.userId} FOR NO KEY UPDATE`);
      await db.delete(p).where(eq(p.userId, row.userId));
      await db.insert(p).values({ id: row.id, userId: row.userId, object64: row.objects[64], object128: row.objects[128], object256: row.objects[256] });
    },
    async remove(userId: string): Promise<boolean> {
      return (await db.delete(p).where(eq(p.userId, userId)).returning({ id: p.id })).length > 0;
    },
    async seenBy(viewerId: string): Promise<Array<{ userId: string; id: string }>> {
      return db.select({ userId: p.userId, id: p.id }).from(p).where(personSeenBySql(viewerId, p.userId));
    },
    async findSeenBy(viewerId: string, photoId: string): Promise<PersonPhotoRecord | null> {
      const [row] = await db.select().from(p).where(sql`${p.id} = ${photoId} AND ${personSeenBySql(viewerId, p.userId)}`);
      return row ? rowOf(row) : null;
    },
  };
}

/** Whether a files-volume object is a rendition of a profile photo: account data, never sealed (F-039). */
export async function isPersonPhotoObject(db: DbExecutor, objectId: string): Promise<boolean> {
  const [row] = await db.select({ id: p.id }).from(p).where(or(eq(p.object64, objectId), eq(p.object128, objectId), eq(p.object256, objectId))).limit(1);
  return !!row;
}
