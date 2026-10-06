import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { nativeWorkEndpointVisible, type NativeWorkReadObject } from './work-read-visibility.js';

/** Bounded selected structural membership, not an existence oracle across projects.
 * Central project.read is checked by the use case before invoking this adapter.
 * One SQL statement observes every selected kind in the same native snapshot.
 */
export function nativeWorkReferenceRows(db: DbExecutor) {
  return {
    async available(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkReadObject[]> {
      if (objects.length < 1 || objects.length > 100) throw new Error('Invalid native reference window');
      const refs = objects.map(({ kind, id }) => sql`(${kind}::text, ${id}::uuid)`);
      const result = await db.execute<NativeWorkReadObject>(sql`WITH refs(kind, id) AS (VALUES ${sql.join(refs, sql`, `)})
        SELECT g.kind, g.id FROM refs g WHERE (${nativeWorkEndpointVisible(projectId, sql`g.kind`, sql`g.id`)})
        ORDER BY g.kind COLLATE "C", g.id`);
      return result.rows;
    },
  };
}
