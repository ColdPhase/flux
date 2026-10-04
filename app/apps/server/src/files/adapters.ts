import { fileRows } from '@flux/db';
import { createFileUseCases, type Database, type FileStorage, type FileUnitOfWork } from '@flux/core';
import { policyWorkAccess } from '../work/access.js';

export function fileUnitOfWork(db: Database): FileUnitOfWork {
  return { run: (action) => db.transaction((tx) => action({ access: policyWorkAccess(tx), files: fileRows(tx) })) };
}
export const fileUseCases = (db: Database, storage: FileStorage) => createFileUseCases(fileUnitOfWork(db), storage);
