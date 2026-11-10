import { sql } from 'drizzle-orm';
import type { DbExecutor } from './push.js';
import { nativeWorkEndpointVisible, type NativeWorkReadObject } from './work-read-visibility.js';
import { executePrepared } from '../prepared.js';

/** Bounded selected structural membership, not an existence oracle across projects.
 * Central project.read is checked by the use case before invoking this adapter.
 * One SQL statement observes every selected kind in the same native snapshot.
 */
export function nativeWorkReferenceRows(db: DbExecutor) {
  return {
    async available(projectId: string, objects: readonly NativeWorkReadObject[]): Promise<NativeWorkReadObject[]> {
      if (objects.length < 1 || objects.length > 100) throw new Error('Invalid native reference window');
      // Prepared, with the objects as two array parameters (#1178): the visibility filter plans in over a millisecond.
      const result = await executePrepared<NativeWorkReadObject>(db, sql`WITH refs(kind, id) AS (
          SELECT * FROM unnest(${sql.param(objects.map(({ kind }) => kind))}::text[], ${sql.param(objects.map(({ id }) => id))}::uuid[]))
        SELECT g.kind, g.id FROM refs g WHERE (${nativeWorkEndpointVisible(projectId, sql`g.kind`, sql`g.id`)})
        ORDER BY g.kind COLLATE "C", g.id`);
      return result.rows;
    },
  };
}
