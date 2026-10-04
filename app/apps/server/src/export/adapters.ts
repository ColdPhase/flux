import { FLUX_SCHEMA_VERSION, projectExportRows } from '@flux/db';
import {
  createProjectExportUseCases,
  enforce,
  evaluateProject,
  listProjectPeople,
  type Database,
  type FileStorage,
  type ProjectExportPorts,
  type ProjectExportUnitOfWork,
  type Transaction,
} from '@flux/core';

// Adapters that connect the core project export (#123) to the access policy and the Drizzle rows.
// Core defines the ports (#46); the server assembles them per transaction.

function exportPorts(tx: Transaction, storage?: FileStorage): ProjectExportPorts {
  return {
    access: {
      async requireManage(principal, projectId) {
        enforce(await evaluateProject(principal, 'project.manage', projectId, tx), 'project');
      },
      audience: (principal, projectId) => listProjectPeople(principal, projectId, tx),
    },
    rows: projectExportRows(tx),
    ...(storage ? { files: storage } : {}),
  };
}

/** A read-only REPEATABLE READ transaction: every part of the export shows the same snapshot. */
export function exportUnitOfWork(db: Database, storage?: FileStorage): ProjectExportUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(exportPorts(tx, storage)), { isolationLevel: 'repeatable read', accessMode: 'read only' }) };
}

export const exportUseCases = (db: Database, instanceOrigin: string | null, storage?: FileStorage) =>
  createProjectExportUseCases(exportUnitOfWork(db, storage), { schemaVersion: FLUX_SCHEMA_VERSION, instanceOrigin });
