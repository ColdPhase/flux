import type { Pool, PoolClient } from 'pg';
import { AGENT_OPERATIONS } from '@flux/contracts';
import { UNDO_CONSTRAINTS, UNDO_GUARD_BODIES } from './task-creation-undo-footprint.js';

type Reader = Pick<Pool | PoolClient, 'query'>;
const taskColumns: Readonly<Record<string, string>> = {
  creation_origin: 'text', creation_baseline: 'jsonb', creation_baseline_version: 'integer', creation_proposal_id: 'uuid',
  first_persisted_use_at: 'timestamp with time zone', creation_reverted_at: 'timestamp with time zone',
  creation_reverted_by_kind: 'text', creation_reverted_by_id: 'text', creation_reversion_notice_id: 'uuid',
};
const receiptColumns: Readonly<Record<string, string>> = {
  workspace_id: 'uuid', project_id: 'uuid', actor_kind: 'text', actor_id: 'text', client_command_id: 'uuid',
  request_fingerprint: 'text', work_id: 'uuid', notice_id: 'uuid', created_at: 'timestamp with time zone',
};
const legacyColumns: Readonly<Record<string, readonly string[]>> = {
  agent_runtime_connections: ['account_fingerprint', 'previous_account_label', 'account_changed_at', 'signed_out_at', 'sign_out_failed'],
  notification_preferences: ['paused_until'],
};
const legacyRelations = ['agent_runtime_auth_operations', 'agent_runtime_console_nonces', 'agent_runtime_auth_admission'];
// Ignore rendering whitespace outside literals; a space inside a CHECK's value is semantic.
const compact = (definition: string) => definition.replace(/('(?:''|[^'])*')|\s+/g, (part, literal: string | undefined) => literal ?? '');

function refuse(problems: readonly string[]): never {
  throw new Error('Flux migration refused: unsupported or ambiguous task-creation Undo / sign-in / runtime-auth / focus catalog: ' +
    problems.join('; ') + '. Restore the matching image and paired database/files backup or use an explicitly reviewed data conversion. ' +
    'Do not renumber migrations, edit the ledger, or remove catalog objects to guess a repair. No migration changes were applied.');
}

/** Read-only preflight, under flux-migrate, before application SQL, ledger or pg-boss writes.
 * 0057/0058/0059 are unsupported in this image. A future composition must review their actual
 * catalog ownership here; merely adding numbered files must never silently admit legacy schemas.
 * Additional unrelated columns/tables do not change these supported semantic footprints.
 */
export async function assertTaskCreationUndoMigrationCompatibility(db: Reader, applied: readonly number[]): Promise<void> {
  const problems: string[] = [];
  const columns = async (relation: string) => (await db.query(`
    SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required, c.relkind AS kind
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    WHERE a.attrelid=pg_catalog.to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
  `, [relation])).rows as { name: string; type: string; required: boolean; kind: string }[];
  for (const [relation, names] of Object.entries(legacyColumns)) {
    const found = (await columns(relation)).filter((column) => names.includes(column.name));
    if (found.length) problems.push(`unsupported legacy ${relation} columns ${found.map((column) => `${column.name}:${column.type}`).join(',')}`);
  }
  for (const relation of legacyRelations) {
    if ((await db.query('SELECT pg_catalog.to_regclass($1) AS relation', [relation])).rows[0].relation) {
      problems.push(`unsupported legacy relation ${relation}`);
    }
  }
  const functions = (await db.query(`SELECT p.proname AS name,p.prosrc AS body,l.lanname AS language,p.prorettype='trigger'::regtype AS trigger
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.oid IN (pg_catalog.to_regprocedure('flux_guard_task_creation_receipt()'),
      pg_catalog.to_regprocedure('flux_guard_task_creation_history()'),pg_catalog.to_regprocedure('invalidate_runtime_auth_operations()'))`)).rows;
  if (functions.some((fn) => fn.name === 'invalidate_runtime_auth_operations')) problems.push('unsupported legacy runtime-auth lifecycle function');
  const triggers = (await db.query(`SELECT t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,
      p.proname AS function,t.tgqual IS NOT NULL AS conditional, t.tgnargs AS arguments
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE (t.tgrelid=pg_catalog.to_regclass('project_work_items') AND t.tgname='task_creation_history_guard')
      OR (t.tgrelid=pg_catalog.to_regclass('task_creation_undo_receipts') AND t.tgname='task_creation_receipt_guard')
      OR (t.tgrelid=pg_catalog.to_regclass('agent_runtime_bindings') AND t.tgname='agent_runtime_auth_lifecycle')`)).rows;
  if (triggers.some((trigger) => trigger.name === 'agent_runtime_auth_lifecycle')) problems.push('unsupported legacy runtime-auth lifecycle trigger');
  const reserved = applied.filter((version) => [57, 58, 59].includes(version));
  if (reserved.length) problems.push(`unsupported reserved ledger versions ${reserved.join(',')} (numeric identity is not catalog identity)`);

  const task = (await columns('project_work_items')).filter((column) => column.name in taskColumns);
  const receiptRelation = (await db.query("SELECT pg_catalog.to_regclass('task_creation_undo_receipts') AS relation")).rows[0].relation;
  const receipts = await columns('task_creation_undo_receipts');
  const constraints = (await db.query(`SELECT c.conname AS name, c.conrelid::regclass::text AS relation,
      pg_catalog.pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
    FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (pg_catalog.to_regclass('project_work_items'),
      pg_catalog.to_regclass('task_creation_undo_receipts'),pg_catalog.to_regclass('project_task_notices'),
      pg_catalog.to_regclass('proactive_comparison_proposals'),pg_catalog.to_regclass('agent_standing_grants'))`)).rows;
  const hasLifecycle = task.length || receiptRelation || functions.some((fn) => fn.name in UNDO_GUARD_BODIES) ||
    triggers.some((trigger) => trigger.name.startsWith('task_creation_')) ||
    constraints.some((constraint) => constraint.name.startsWith('task_creation_') || constraint.name === 'task_notice_scope_identity' ||
      constraint.name.startsWith('project_work_items_creation_') ||
      constraint.name === 'project_task_notices_kind_check' && constraint.definition.includes("'task.creation_reverted'"));
  if (!applied.includes(48)) {
    if (hasLifecycle) problems.push('unversioned or partial Undo lifecycle without ledger 48');
  } else {
    for (const [relation, actual, expected, required] of [
      ['project_work_items', task, taskColumns, false], ['task_creation_undo_receipts', receipts, receiptColumns, true],
    ] as const) {
      for (const [name, type] of Object.entries(expected)) {
        const column = actual.find((entry) => entry.name === name);
        if (!column || column.type !== type || column.required !== required || column.kind !== 'r') problems.push(`mismatched Undo column ${relation}.${name}:${type}`);
      }
    }
    for (const [relation, name, definition] of UNDO_CONSTRAINTS) {
      const actual = constraints.find((constraint) => constraint.relation === relation && constraint.name === name);
      if (!actual?.validated || compact(actual.definition) !== compact(definition)) problems.push(`mismatched Undo constraint ${relation}.${name}`);
    }
    for (const [name, body] of Object.entries(UNDO_GUARD_BODIES)) {
      const fn = functions.find((entry) => entry.name === name);
      if (!fn?.trigger || fn.language !== 'plpgsql' || compact(fn.body) !== compact(body)) problems.push(`mismatched Undo guard function ${name}`);
    }
    for (const [name, type, fn] of [['task_creation_history_guard', 19, 'flux_guard_task_creation_history'],
      ['task_creation_receipt_guard', 27, 'flux_guard_task_creation_receipt']] as const) {
      const trigger = triggers.find((entry) => entry.name === name);
      if (!trigger || trigger.type !== type || trigger.enabled !== 'O' || trigger.function !== fn || trigger.conditional || trigger.arguments !== 0) {
        problems.push(`mismatched Undo guard trigger ${name}`);
      }
    }
  }
  const grant = constraints.find((constraint) => constraint.relation === 'agent_standing_grants' && constraint.name === 'agent_standing_grants_operation_check');
  if (applied.includes(60) || applied.includes(54)) {
    const operations = AGENT_OPERATIONS.filter((operation) => applied.includes(60) || operation !== 'work.creation.revert');
    const expected = `CHECK ((operation = ANY (ARRAY[${operations.map((operation) => `'${operation}'::text`).join(', ')}])))`;
    // SQL's order is stable but differs from the contract's order; compare the entire CHECK with sorted literals.
    const sorted = (definition: string) => compact(definition.replace(/ARRAY\[([^\]]*)\]/, (_, values: string) =>
      `ARRAY[${values.split(',').map((value) => value.trim()).sort().join(',')}]`));
    if (!grant?.validated || sorted(grant.definition) !== sorted(expected)) problems.push('mismatched Undo standing-grant operation CHECK');
  } else if (grant?.definition.includes("'work.creation.revert'")) problems.push('unversioned legacy Undo grant widening without ledger 60');
  if (applied.includes(60) && !applied.includes(48)) problems.push('partial Undo ledger 60 without lifecycle 48');
  if (problems.length) refuse(problems);
}
