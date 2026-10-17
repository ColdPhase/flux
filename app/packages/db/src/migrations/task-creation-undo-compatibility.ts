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
// Sign-in 0096 and runtime-auth 0097 are admitted only with their own ledger versions (ledger 97 needs 96).
// Without those ledger versions, the same objects refuse as unsupported legacy footprints.
const signInColumns: Readonly<Record<string, string>> = {
  account_fingerprint: 'text', previous_account_label: 'text', account_changed_at: 'timestamp with time zone',
  signed_out_at: 'timestamp with time zone', sign_out_failed: 'boolean',
};
const runtimeAuthRelations = ['agent_runtime_auth_operations', 'agent_runtime_console_nonces', 'agent_runtime_auth_admission'];
const runtimeAuthFunction = 'invalidate_runtime_auth_operations';
const runtimeAuthTrigger = 'agent_runtime_auth_lifecycle';
// Ignore rendering whitespace outside literals; a space inside a CHECK's value is semantic.
const compact = (definition: string) => definition.replace(/('(?:''|[^'])*')|\s+/g, (part, literal: string | undefined) => literal ?? '');

function refuse(problems: readonly string[]): never {
  throw new Error('Flux migration refused: unsupported or ambiguous task-creation Undo / sign-in / runtime-auth / focus catalog: ' +
    problems.join('; ') + '. Restore the matching image and paired database/files backup or use an explicitly reviewed data conversion. ' +
    'Do not renumber migrations, edit the ledger, or remove catalog objects to guess a repair. No migration changes were applied.');
}

/** Read-only preflight, under flux-migrate, before application SQL, ledger or pg-boss writes.
 * Ledger 57/58 remain unsupported. Sign-in 0096 and runtime-auth 0097 are admitted only with
 * their own ledger versions, and their exact catalog shapes are checked. Current 0059 is the
 * accepted Focus migration, and its exact nullable timestamptz footprint is admitted only with
 * ledger 59. Additional unrelated columns/tables do not change these supported semantic footprints.
 */
export async function assertTaskCreationUndoMigrationCompatibility(db: Reader, applied: readonly number[]): Promise<void> {
  const problems: string[] = [];
  const relationKind = async (relation: string) => (await db.query(
    'SELECT c.relkind AS kind FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)', [relation])).rows[0]?.kind as string | undefined;
  const columns = async (relation: string) => (await db.query(`
    SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required, c.relkind AS kind
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    WHERE a.attrelid=pg_catalog.to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
  `, [relation])).rows as { name: string; type: string; required: boolean; kind: string }[];
  const signIn = (await columns('agent_runtime_connections')).filter((column) => Object.hasOwn(signInColumns, column.name));
  if (applied.includes(96)) {
    for (const [name, type] of Object.entries(signInColumns)) {
      const column = signIn.find((entry) => entry.name === name);
      if (!column || column.type !== type || column.required || column.kind !== 'r') problems.push(`mismatched sign-in 0096 column agent_runtime_connections.${name}:${type}`);
    }
  } else if (signIn.length) {
    problems.push(`unsupported legacy agent_runtime_connections columns ${signIn.map((column) => `${column.name}:${column.type}`).join(',')}`);
  }
  const authRelations = new Map(await Promise.all(runtimeAuthRelations.map(async (relation) => [relation, await relationKind(relation)] as const)));
  for (const relation of runtimeAuthRelations) {
    if (applied.includes(97)) {
      if (authRelations.get(relation) !== 'r') problems.push(`mismatched runtime-auth 0097 relation ${relation}`);
    } else if (authRelations.get(relation)) {
      problems.push(`unsupported legacy relation ${relation}`);
    }
  }
  if (applied.includes(97) && !applied.includes(96)) problems.push('partial runtime-auth ledger 97 without sign-in ledger 96');
  const functions = (await db.query(`SELECT p.oid,p.proname AS name,p.prosrc AS body,l.lanname AS language,p.prorettype='trigger'::regtype AS trigger
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.oid IN (pg_catalog.to_regprocedure('flux_guard_task_creation_receipt()'),
      pg_catalog.to_regprocedure('flux_guard_task_creation_history()'),pg_catalog.to_regprocedure('invalidate_runtime_auth_operations()'))`)).rows;
  const authFunction = functions.find((fn) => fn.name === runtimeAuthFunction);
  if (applied.includes(97)) {
    if (!authFunction?.trigger || authFunction.language !== 'plpgsql') problems.push('mismatched runtime-auth 0097 lifecycle function');
  } else if (authFunction) problems.push('unsupported legacy runtime-auth lifecycle function');
  const triggers = (await db.query(`SELECT t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,
      p.proname AS function,t.tgfoid AS function_oid,t.tgqual IS NOT NULL AS conditional, t.tgnargs AS arguments
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE (t.tgrelid=pg_catalog.to_regclass('project_work_items') AND t.tgname='task_creation_history_guard')
      OR (t.tgrelid=pg_catalog.to_regclass('task_creation_undo_receipts') AND t.tgname='task_creation_receipt_guard')
      OR (t.tgrelid=pg_catalog.to_regclass('agent_runtime_bindings') AND t.tgname='agent_runtime_auth_lifecycle')`)).rows;
  const authTrigger = triggers.find((trigger) => trigger.name === runtimeAuthTrigger);
  if (applied.includes(97)) {
    // AFTER UPDATE OF state, FOR EACH ROW (type bits 1 row + 16 update), no WHEN clause, no arguments.
    if (!authTrigger || authTrigger.enabled !== 'O' || authTrigger.type !== 17 || authTrigger.function !== runtimeAuthFunction ||
      authTrigger.function_oid !== authFunction?.oid || authTrigger.conditional || authTrigger.arguments !== 0) problems.push('mismatched runtime-auth 0097 lifecycle trigger');
  } else if (authTrigger) problems.push('unsupported legacy runtime-auth lifecycle trigger');
  const reserved = applied.filter((version) => [57, 58].includes(version));
  if (reserved.length) problems.push(`unsupported reserved ledger versions ${reserved.join(',')} (numeric identity is not catalog identity)`);

  const pauseColumn = (await columns('notification_preferences')).find((column) => column.name === 'paused_until');
  if (applied.includes(59)) {
    if (!pauseColumn || pauseColumn.type !== 'timestamp with time zone' || pauseColumn.required || pauseColumn.kind !== 'r') {
      problems.push('mismatched accepted Focus 0059 column notification_preferences.paused_until');
    }
  } else if (pauseColumn) {
    problems.push('unversioned Focus 0059 column notification_preferences.paused_until');
  }

  const task = (await columns('project_work_items')).filter((column) => Object.hasOwn(taskColumns, column.name));
  const receiptRelation = (await db.query("SELECT pg_catalog.to_regclass('task_creation_undo_receipts') AS relation")).rows[0].relation;
  const receipts = await columns('task_creation_undo_receipts');
  const constraints = (await db.query(`SELECT c.conname AS name, c.conrelid::regclass::text AS relation,
      pg_catalog.pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
    FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (pg_catalog.to_regclass('project_work_items'),
      pg_catalog.to_regclass('task_creation_undo_receipts'),pg_catalog.to_regclass('project_task_notices'),
      pg_catalog.to_regclass('proactive_comparison_proposals'),pg_catalog.to_regclass('agent_standing_grants'))`)).rows;
  const hasLifecycle = task.length || receiptRelation || functions.some((fn) => Object.hasOwn(UNDO_GUARD_BODIES, fn.name)) ||
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
      const validatedFunction = functions.find((entry) => entry.name === fn);
      if (!trigger || trigger.type !== type || trigger.enabled !== 'O' || trigger.function !== fn ||
        trigger.function_oid !== validatedFunction?.oid || trigger.conditional || trigger.arguments !== 0) {
        problems.push(`mismatched Undo guard trigger ${name}`);
      }
    }
  }
  const grant = constraints.find((constraint) => constraint.relation === 'agent_standing_grants' && constraint.name === 'agent_standing_grants_operation_check');
  if (applied.includes(60) || applied.includes(54)) {
    const operations = AGENT_OPERATIONS.filter((operation) => (applied.includes(60) || operation !== 'work.creation.revert')
      && (applied.includes(107) || operation !== 'cowork.unit.decline'));
    const expected = `CHECK ((operation = ANY (ARRAY[${operations.map((operation) => `'${operation}'::text`).join(', ')}])))`;
    // SQL's order is stable but differs from the contract's order; compare the entire CHECK with sorted literals.
    const sorted = (definition: string) => compact(definition.replace(/ARRAY\[([^\]]*)\]/, (_, values: string) =>
      `ARRAY[${values.split(',').map((value) => value.trim()).sort().join(',')}]`));
    if (!grant?.validated || sorted(grant.definition) !== sorted(expected)) problems.push('mismatched Undo standing-grant operation CHECK');
  } else if (grant?.definition.includes("'work.creation.revert'")) problems.push('unversioned legacy Undo grant widening without ledger 60');
  if (applied.includes(60) && !applied.includes(48)) problems.push('partial Undo ledger 60 without lifecycle 48');
  if (problems.length) refuse(problems);
}
