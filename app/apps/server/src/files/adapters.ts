import { fileRows, runPictureRows, type Database } from '@flux/db';
import { createFileUseCases, type FileStorage, type FileUnitOfWork, type FileUseCaseOptions } from '@flux/core';
import { policyWorkAccess } from '../work/access.js';

export function fileUnitOfWork(db: Database): FileUnitOfWork {
  return { run: (action) => db.transaction((tx) => action({ access: policyWorkAccess(tx), files: fileRows(tx), runPictures: runPictureRows(tx) })) };
}
/**
 * With `options.pictures`, every picture staged is decoded and written again first (#1343); without one, bytes are stored as they arrive.
 * `options.videoBytes` and `options.poster` are the videos of C-61.
 */
export const fileUseCases = (db: Database, storage: FileStorage, options: FileUseCaseOptions = {}) => createFileUseCases(fileUnitOfWork(db), storage, undefined, options);
