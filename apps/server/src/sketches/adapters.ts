import { sketchRows, type DbExecutor } from '@flux/db';
import {
  createSketchUseCases,
  policySketchAccess,
  recordEvent,
  visibleFilter,
  type Database,
  type Principal,
  type SketchPorts,
  type SketchRepository,
  type SketchUnitOfWork,
} from '@flux/core';

// Adapters that connect the core sketch use cases to Drizzle, the access policy and the event
// log (issue #69; #46: core defines the ports, the server assembles them).

function author(principal: Principal): { kind: 'human' | 'agent'; id: string } {
  if (principal.kind === 'fixture') throw new Error('A fixture principal cannot author sketch content');
  return { kind: principal.kind, id: principal.id };
}

export function sketchRepository(db: DbExecutor): SketchRepository {
  const rows = sketchRows(db);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, filter, page) {
      return rows.list(workspaceId, await visibleFilter(principal, workspaceId, 'sketch', db), filter, page);
    },
    insertSketch: (sketch) => rows.insertSketch({ ...sketch, createdBy: author(sketch.createdBy) }),
    insertThought: (thought) => rows.insertThought({ ...thought, createdBy: author(thought.createdBy) }),
    insertLink: (link) => rows.insertLink({ ...link, createdBy: author(link.createdBy) }),
  };
}

function sketchPorts(tx: DbExecutor): SketchPorts {
  return {
    access: policySketchAccess(tx),
    sketches: sketchRepository(tx),
    events: { record: async (principal, workspaceId, kind, sketchId, data) => { await recordEvent(tx, principal, workspaceId, kind, sketchId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function sketchUnitOfWork(db: Database): SketchUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(sketchPorts(tx))) };
}

/** The sketch use cases bound to a connection or transaction. */
export const sketchUseCases = (db: Database) => createSketchUseCases(sketchUnitOfWork(db));
