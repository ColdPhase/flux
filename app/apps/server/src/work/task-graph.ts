import { taskGraphRows } from '@flux/db';
import { assertPrerequisitesMet, directPrerequisiteIds, lockProjectGraphs, type Transaction } from '@flux/core';

// The three transaction-bound task-graph primitives of #152 (interface pinned in
// docs/development/agent-connection/2026-10-01-native-plan-contract.md), for every dependency/intent
// writer and for the #153 claim path. Core owns the rules and the visible errors
// (`packages/core/src/work/task-graph.ts`), `@flux/db` owns the SQL and the lock namespace
// (`taskGraphRows`); this composition root joins them because core cannot import persistence and the
// database package cannot raise core's domain errors. They open no transaction, flush no event and
// run in the caller's open `tx`.
//
// Full lock order for any path touching tasks: authority/grant/command and plan-material rows ->
// connection slots -> `lockProjectTaskGraphs` (ascending project id) -> the complete task rows in one
// ascending pass (the tasks plus `taskPrerequisiteIds`) -> coordination rows -> actor commands and
// conversations -> the single final event batch. Never take a graph lock after a task lock or a
// stream insert.

/**
 * One `pg_advisory_xact_lock(hashtextextended('flux.task-graph:' || projectId, 0))` per project, taken in
 * ascending order of the lowercased, de-duplicated ids. It locks no task, unit, stream or material row.
 */
export function lockProjectTaskGraphs(tx: Transaction, projectIds: readonly string[]): Promise<void> {
  return lockProjectGraphs(taskGraphRows(tx), projectIds);
}

/**
 * The distinct, lowercase, ascending ids of the direct same-project prerequisites of these tasks, with no
 * transitive closure. Read-only. More than `TASK_GRAPH_LIMIT` is the visible 409 `TASK_GRAPH_LIMIT`,
 * never a truncated list. The caller adds the ids to its single sorted task lock pass.
 */
export function taskPrerequisiteIds(tx: Transaction, workspaceId: string, taskIds: readonly string[]): Promise<string[]> {
  return directPrerequisiteIds(taskGraphRows(tx), workspaceId, taskIds);
}

/**
 * Run after the caller holds the complete sorted task locks; takes none itself and reads the locked
 * current rows. Every direct prerequisite must exist in the task's workspace and project and be `done`
 * and unparked, otherwise 409 `TASK_PREREQUISITES_UNMET` (404 when the task itself is not there).
 */
export function requireTaskPrerequisitesMet(tx: Transaction, workspaceId: string, taskId: string): Promise<void> {
  return assertPrerequisitesMet(taskGraphRows(tx), workspaceId, taskId);
}
