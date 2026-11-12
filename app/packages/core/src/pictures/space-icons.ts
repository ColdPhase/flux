import { randomUUID } from 'node:crypto';
import { isSpaceEmoji, PICTURE_LIMITS, PICTURE_SIZES, type PictureSize, type SpaceIcon } from '@flux/contracts';
import { recordEvent } from '../events.js';
import type { Database, Executor, Principal } from '../types.js';
import { eventPorts } from '../access/common.js';
import { InvalidInputError, PayloadTooLargeError } from '../access/errors.js';
import { enforce, evaluateProject, isUuid } from '../access/policy.js';
import type { AccessPorts } from '../access/repositories.js';
import type { FileStorage } from '../files/ports.js';
import type { PictureRenderer } from './ports.js';
import { readRendition, removeObjects, storeRenditions } from './service.js';

/** What a space's icon is written as (F-040): an emoji, or a picture with its renditions' objects. */
export type SpaceIconWrite = { projectId: string; workspaceId: string; changedBy: string }
  & ({ emoji: string } | { picture: string; objects: Record<PictureSize, string> });

/** Rows only; every method runs in the caller's transaction. A removed picture's objects are queued for deletion with its row. */
export interface SpaceIconRepository {
  replace(row: SpaceIconWrite): Promise<void>;
  remove(projectId: string): Promise<boolean>;
  findPicture(pictureId: string): Promise<{ projectId: string; objects: Record<PictureSize, string> } | null>;
}

export type SpaceIconPorts = Pick<AccessPorts, 'projects' | 'access' | 'events'> & { icons: (db: Executor) => SpaceIconRepository };

/**
 * Space icons (F-040, #1227): the people who can rename a space (`project.manage`) set an emoji or a picture, or go back to the letter.
 * Each change locks the space as a rename does and records `project.updated.v1`, so every open sidebar reads it again. A picture is
 * rendered and stored before the transaction (only after a first check of the right, so nobody else makes Flux render), and its
 * objects are removed again when the change does not commit.
 */
export function createSpaceIconUseCases(db: Database, ports: SpaceIconPorts, storage: FileStorage, renderer: PictureRenderer) {
  async function change(principal: Principal, projectId: string, write: (icons: SpaceIconRepository, workspaceId: string) => Promise<void>) {
    await db.transaction(async (tx) => {
      await ports.projects(tx).lockForGrantChange(projectId);
      const { project } = enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(tx), { lock: true }), 'project');
      await write(ports.icons(tx), project!.workspaceId);
      await recordEvent(eventPorts(ports, tx), principal, project!.workspaceId, 'project.updated.v1', projectId, {});
    });
  }
  return {
    async setEmoji(principal: Principal, projectId: string, emoji: unknown): Promise<SpaceIcon> {
      if (!isSpaceEmoji(emoji)) throw new InvalidInputError('Choose one emoji', 'INVALID_SPACE_EMOJI');
      await change(principal, projectId, (icons, workspaceId) => icons.replace({ projectId, workspaceId, changedBy: principal.id, emoji }));
      return { emoji };
    },
    async setPicture(principal: Principal, projectId: string, bytes: Uint8Array): Promise<SpaceIcon> {
      if (bytes.byteLength > PICTURE_LIMITS.spaceIconBytes) throw new PayloadTooLargeError('A space icon is at most 2 MiB', 'SPACE_ICON_TOO_LARGE');
      if (bytes.byteLength < 1) throw new InvalidInputError('Send the picture\'s bytes', 'UNSUPPORTED_PICTURE');
      enforce(await evaluateProject(principal, 'project.manage', projectId, ports.access(db)), 'project');
      const objects = await storeRenditions(storage, await renderer.render(bytes));
      const picture = randomUUID();
      try {
        await change(principal, projectId, (icons, workspaceId) => icons.replace({ projectId, workspaceId, changedBy: principal.id, picture, objects }));
      } catch (error) {
        await removeObjects(storage, Object.values(objects));
        throw error;
      }
      return { picture };
    },
    async removeIcon(principal: Principal, projectId: string): Promise<void> {
      await change(principal, projectId, async (icons) => { await icons.remove(projectId); });
    },
    /** One rendition of a space's picture, for someone who can open the space now; anything else is a 404. */
    async readPicture(principal: Principal, pictureId: string, size: PictureSize): Promise<Uint8Array | null> {
      if (!isUuid(pictureId) || !PICTURE_SIZES.includes(size)) return null;
      const found = await ports.icons(db).findPicture(pictureId);
      if (!found || !(await evaluateProject(principal, 'project.read', found.projectId, ports.access(db))).allowed) return null;
      return readRendition(storage, found.objects[size]);
    },
  };
}
export type SpaceIconUseCases = ReturnType<typeof createSpaceIconUseCases>;
