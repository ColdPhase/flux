import { eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PictureSize, SpaceIcon } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

const i = schema.spaceIcons;

/** Core's `SpaceIconWrite` (F-040): an emoji, or a picture with its renditions' objects. */
export type SpaceIconRecord = { projectId: string; workspaceId: string; changedBy: string }
  & ({ emoji: string } | { picture: string; objects: Record<PictureSize, string> });

const iconOf = (row: { emoji: string | null; picture: string | null }): SpaceIcon | null =>
  row.emoji ? { emoji: row.emoji } : row.picture ? { picture: row.picture } : null;

/** SQL: the space's icon as JSON (`{"emoji": …}` or `{"picture": …}`), or null for its letter; for a list of `projects` rows. */
export function spaceIconSql(projectId: SQLWrapper): SQL<SpaceIcon | null> {
  return sql<SpaceIcon | null>`(SELECT CASE WHEN si.emoji IS NOT NULL THEN json_build_object('emoji', si.emoji) ELSE json_build_object('picture', si.picture) END
    FROM space_icons si WHERE si.project_id = ${projectId})`;
}

/**
 * Space icons (F-040, #1227). Every method runs in the caller's transaction, after the caller has locked the space and decided the
 * right. Deleting a row queues a picture's objects in `file_garbage` (trigger `space_icon_garbage`).
 */
export function spaceIconRows(db: DbExecutor) {
  return {
    async replace(row: SpaceIconRecord): Promise<void> {
      await db.delete(i).where(eq(i.projectId, row.projectId));
      await db.insert(i).values({ projectId: row.projectId, workspaceId: row.workspaceId, changedBy: row.changedBy,
        ...('emoji' in row ? { emoji: row.emoji } : { picture: row.picture, object64: row.objects[64], object128: row.objects[128], object256: row.objects[256] }) });
    },
    async remove(projectId: string): Promise<boolean> {
      return (await db.delete(i).where(eq(i.projectId, projectId)).returning({ projectId: i.projectId })).length > 0;
    },
    async iconsOf(projectIds: readonly string[]): Promise<Map<string, SpaceIcon>> {
      if (!projectIds.length) return new Map();
      const rows = await db.select({ projectId: i.projectId, emoji: i.emoji, picture: i.picture }).from(i).where(inArray(i.projectId, [...projectIds]));
      return new Map(rows.flatMap((row) => { const icon = iconOf(row); return icon ? [[row.projectId, icon] as const] : []; }));
    },
    /** The space a picture is the icon of, and its renditions' objects; the caller decides whether the reader may open the space. */
    async findPicture(pictureId: string): Promise<{ projectId: string; objects: Record<PictureSize, string> } | null> {
      const [row] = await db.select().from(i).where(eq(i.picture, pictureId));
      return row?.object64 && row.object128 && row.object256 ? { projectId: row.projectId, objects: { 64: row.object64, 128: row.object128, 256: row.object256 } } : null;
    },
  };
}

/** Whether a files-volume object is a rendition of a space icon. A space with one is never an encrypted one, so it is never sealed. */
export async function isSpaceIconObject(db: DbExecutor, objectId: string): Promise<boolean> {
  const [row] = await db.select({ id: i.projectId }).from(i).where(or(eq(i.object64, objectId), eq(i.object128, objectId), eq(i.object256, objectId))).limit(1);
  return !!row;
}
