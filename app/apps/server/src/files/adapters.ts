import { fileRows, runPictureRows, type Database } from '@flux/db';
import { createFileUseCases, type FileStorage, type FileUnitOfWork } from '@flux/core';
import { policyWorkAccess } from '../work/access.js';

export function fileUnitOfWork(db: Database): FileUnitOfWork {
  return { run: (action) => db.transaction((tx) => action({ access: policyWorkAccess(tx), files: fileRows(tx), runPictures: runPictureRows(tx) })) };
}
export const fileUseCases = (db: Database, storage: FileStorage) => createFileUseCases(fileUnitOfWork(db), storage);
