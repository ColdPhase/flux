import { eq } from 'drizzle-orm';
import { accessReader, fileRows, runPictureRows, schema, type Database, type Transaction } from '@flux/db';
import { createFileUseCases, NotFoundError, policyDmAccess, type FilePorts, type FileStorage, type FileUnitOfWork, type FileUseCaseOptions } from '@flux/core';
import { policyWorkAccess } from '../work/access.js';

/** The right to read or write a direct message's files is the conversation's own (`policyDmAccess`), checked on every request (#1438 point 10). */
function dmFileAccess(tx: Transaction): NonNullable<FilePorts['access']['requireDm']> {
  const access = policyDmAccess(accessReader(tx));
  return async (principal, action, dmId, options) => {
    await access.requireDm(principal, action, dmId, options);
    const [dm] = await tx.select({ workspaceId: schema.dms.workspaceId }).from(schema.dms).where(eq(schema.dms.id, dmId));
    if (!dm) throw new NotFoundError('Conversation', 'DM_NOT_FOUND');
    return dm;
  };
}

export function fileUnitOfWork(db: Database): FileUnitOfWork {
  return { run: (action) => db.transaction((tx) => action({ access: { ...policyWorkAccess(tx), requireDm: dmFileAccess(tx) }, files: fileRows(tx), runPictures: runPictureRows(tx) })) };
}
/**
 * With `options.pictures`, every picture staged is decoded and written again first (#1343); without one, bytes are stored as they arrive.
 * `options.videoBytes` and `options.poster` are the videos of C-61.
 */
export const fileUseCases = (db: Database, storage: FileStorage, options: FileUseCaseOptions = {}) => createFileUseCases(fileUnitOfWork(db), storage, undefined, options);
