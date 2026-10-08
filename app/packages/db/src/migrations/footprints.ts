import type { Pool, PoolClient } from 'pg';
import { assertKnownMigrationVersions, type MigrationFile } from './ledger.js';

type Reader = Pick<Pool | PoolClient, 'query'>;
type Column = [name: string, type: string, notNull: boolean, defaultExpression?: string];
interface TableFootprint { columns: Column[]; checks: Record<string, string>; exact?: boolean; }
interface Declaration { file: MigrationFile; tables: Record<string, TableFootprint>; }

const textArray = (values: string[]) => `ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}]`;
const oneOf = (column: string, values: string[]) => `CHECK ((${column} = ANY (${textArray(values)})))`;
const maskedLabel = (column: string) => `CHECK (((length(${column}) <= 80) AND (strpos(${column}, '*'::text) > 0) AND (${column} !~ '[[:space:]]'::text)))`;
const hex = (column: string) => `CHECK ((${column} ~ '^[0-9a-f]{64}$'::text))`;
const methods = ['claude_account', 'console', 'sso', 'device_code', 'api_key', 'access_token'];
const releaseReasons = ['owner', 'operator', 'idle', 'purge', 'bind_failed'];

// This registry declares ownership by exact image filename, not by a historic numeric stamp.
// Future 48/59/60 composition extends these descriptors and its PostgreSQL controls explicitly.
const declarations: Declaration[] = [
  { file: { name: '0054_cowork_unit_transitions.sql', version: 54 }, tables: {
    agent_standing_grants: { exact: false, columns: [], checks: {
      agent_standing_grants_operation_check: oneOf('operation', ['work.create', 'work.update', 'result.record', 'decision.propose',
        'map.create', 'map.rename', 'map.thought.create', 'map.thought.update', 'map.thought.delete', 'map.positions.update', 'map.link.create', 'map.link.delete',
        'doc.create', 'doc.update', 'conversation.create', 'conversation.reply', 'cowork.claim', 'cowork.renew', 'cowork.release',
        'cowork.request', 'cowork.request.claim', 'cowork.request.respond', 'cowork.unit.create', 'cowork.unit.complete', 'cowork.unit.transfer']),
    } },
  } },
  { file: { name: '0056_agent_runtime.sql', version: 56 }, tables: {
    agent_runtime_slots: {
      columns: [['slot', 'text', true], ['state', 'text', true], ['boot_id', 'uuid', false], ['wipe_boot_id', 'uuid', false],
        ['out_of_pool_reason', 'text', false], ['reported_at', 'timestamp with time zone', false], ['updated_at', 'timestamp with time zone', true, 'now()']],
      checks: {
        agent_runtime_slots_slot_check: "CHECK ((slot ~ '^runtime-[1-9][0-9]{0,2}$'::text))",
        agent_runtime_slots_state_check: oneOf('state', ['unknown', 'ready', 'held', 'wiping', 'out_of_pool']),
        agent_runtime_slots_out_of_pool_reason_check: oneOf('out_of_pool_reason', ['data_not_empty', 'release_failed', 'missing']),
        agent_runtime_slots_out_of_pool_check: "CHECK (((state = 'out_of_pool'::text) = (out_of_pool_reason IS NOT NULL)))",
        agent_runtime_slots_wiping_check: "CHECK (((state <> 'wiping'::text) OR (wipe_boot_id IS NOT NULL)))",
      },
    },
    agent_runtime_bindings: {
      columns: [['id', 'uuid', true], ['owner_user_id', 'text', true], ['slot', 'text', true], ['state', 'text', true],
        ['created_at', 'timestamp with time zone', true, 'now()'], ['last_used_at', 'timestamp with time zone', false],
        ['release_reason', 'text', false], ['release_requested_at', 'timestamp with time zone', false],
        ['released_at', 'timestamp with time zone', false], ['release_logout_failed', 'boolean', false]],
      checks: {
        agent_runtime_bindings_id_check: "CHECK (((id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
        agent_runtime_bindings_state_check: oneOf('state', ['binding', 'active', 'sign_in_again', 'releasing', 'released']),
        agent_runtime_bindings_release_reason_check: oneOf('release_reason', releaseReasons),
        agent_runtime_bindings_release_check: `CHECK ((((state = ANY (${textArray(['releasing', 'released'])})) = (release_reason IS NOT NULL)) AND
          ((release_reason IS NULL) = (release_requested_at IS NULL)) AND ((state = 'released'::text) = (released_at IS NOT NULL)) AND
          ((state = 'released'::text) OR (release_logout_failed IS NULL))))`,
      },
    },
    agent_runtime_connections: {
      columns: [['id', 'uuid', true], ['owner_user_id', 'text', true], ['binding_id', 'uuid', true], ['transport', 'text', true, "'runtime'::text"],
        ['client', 'text', true], ['state', 'text', true], ['sign_in_method', 'text', false], ['auth_method', 'text', false],
        ['plan_label', 'text', false], ['account_label', 'text', false], ['signed_in_at', 'timestamp with time zone', false],
        ['created_at', 'timestamp with time zone', true, 'now()'], ['revoked_at', 'timestamp with time zone', false]],
      checks: {
        agent_runtime_connections_transport_check: "CHECK ((transport = 'runtime'::text))",
        agent_runtime_connections_client_check: oneOf('client', ['claude_code', 'codex']),
        agent_runtime_connections_state_check: oneOf('state', ['signed_out', 'signed_in', 'sign_in_again']),
        agent_runtime_connections_sign_in_method_check: oneOf('sign_in_method', methods),
        agent_runtime_connections_auth_method_check: "CHECK ((auth_method ~ '^[a-z][a-z0-9_.-]{0,31}$'::text))",
        agent_runtime_connections_plan_label_check: "CHECK (((length(plan_label) <= 40) AND (plan_label ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]*$'::text)))",
        agent_runtime_connections_account_label_check: maskedLabel('account_label'),
        agent_runtime_connections_signed_in_check: "CHECK (((state = 'signed_in'::text) = (signed_in_at IS NOT NULL)))",
        agent_runtime_connections_method_check: `CHECK (((client <> 'claude_code'::text) OR (sign_in_method IS NULL) OR
          (sign_in_method = ANY (${textArray(['claude_account', 'console', 'sso'])}))))`,
        agent_runtime_connections_codex_method_check: `CHECK (((client <> 'codex'::text) OR (sign_in_method IS NULL) OR
          (sign_in_method = ANY (${textArray(['device_code', 'api_key', 'access_token'])}))))`,
        agent_runtime_connections_revoked_check: "CHECK (((revoked_at IS NULL) OR (state <> 'signed_in'::text)))",
      },
    },
    agent_runtime_operator_statements: {
      columns: [['statement', 'text', true], ['agreed_on', 'date', true], ['recorded_at', 'timestamp with time zone', true, 'now()']],
      checks: { agent_runtime_operator_statements_statement_check: "CHECK ((statement = 'anthropic_commercial_terms'::text))",
        agent_runtime_operator_statements_agreed_on_check: "CHECK ((agreed_on >= '2023-01-01'::date))" },
    },
  } },
  { file: { name: '0057_agent_runtime_sign_in.sql', version: 57 }, tables: {
    agent_runtime_connections: {
      columns: [['account_fingerprint', 'text', false], ['previous_account_label', 'text', false], ['account_changed_at', 'timestamp with time zone', false],
        ['signed_out_at', 'timestamp with time zone', false], ['sign_out_failed', 'boolean', false]],
      checks: {
        agent_runtime_connections_fingerprint_check: hex('account_fingerprint'),
        agent_runtime_connections_previous_label_check: maskedLabel('previous_account_label'),
        agent_runtime_connections_notice_check: 'CHECK (((account_changed_at IS NOT NULL) OR (previous_account_label IS NULL)))',
        agent_runtime_connections_sign_out_check: 'CHECK (((signed_out_at IS NULL) = (sign_out_failed IS NULL)))',
      },
    },
  } },
  { file: { name: '0058_agent_runtime_auth_operations.sql', version: 58 }, tables: {
    agent_runtime_bindings: { columns: [], checks: { agent_runtime_bindings_release_reason_check: oneOf('release_reason', [...releaseReasons, 'auth_recovery']) } },
    agent_runtime_auth_operations: {
      columns: [['binding_id', 'uuid', true], ['client', 'text', true], ['owner_user_id', 'text', true], ['operation_id', 'uuid', true],
        ['revision', 'integer', true], ['boot_id', 'uuid', true], ['actor_digest', 'text', true], ['kind', 'text', true], ['phase', 'text', true],
        ['claimed_at', 'timestamp with time zone', true, 'clock_timestamp()'], ['lease_ends_at', 'timestamp with time zone', true],
        ['hard_ends_at', 'timestamp with time zone', true], ['settled_at', 'timestamp with time zone', false]],
      checks: {
        agent_runtime_auth_operations_client_check: oneOf('client', ['claude_code', 'codex']),
        agent_runtime_auth_operations_operation_id_check: "CHECK (((operation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
        agent_runtime_auth_operations_revision_check: 'CHECK ((revision > 0))',
        agent_runtime_auth_operations_actor_digest_check: hex('actor_digest'),
        agent_runtime_auth_operations_kind_check: oneOf('kind', ['check', 'logout', 'console']),
        agent_runtime_auth_operations_phase_check: oneOf('phase', ['active', 'settled', 'uncertain']),
        agent_runtime_auth_operations_check: 'CHECK (((claimed_at < lease_ends_at) AND (lease_ends_at <= hard_ends_at)))',
        agent_runtime_auth_operations_check1: "CHECK (((phase = 'settled'::text) = (settled_at IS NOT NULL)))",
      },
    },
    agent_runtime_console_nonces: {
      columns: [['nonce_digest', 'text', true], ['owner_user_id', 'text', true], ['actor_digest', 'text', true], ['operation_id', 'uuid', true],
        ['expires_at', 'timestamp with time zone', true], ['consumed_at', 'timestamp with time zone', true, 'clock_timestamp()']],
      checks: { agent_runtime_console_nonces_nonce_digest_check: hex('nonce_digest'), agent_runtime_console_nonces_actor_digest_check: hex('actor_digest'),
        agent_runtime_console_nonces_check: 'CHECK ((consumed_at < expires_at))' },
    },
    agent_runtime_auth_admission: {
      columns: [['singleton', 'boolean', true, 'true'], ['blocked', 'boolean', true, 'false'], ['purge_id', 'uuid', false],
        ['changed_at', 'timestamp with time zone', true, 'clock_timestamp()']],
      checks: { agent_runtime_auth_admission_singleton_check: 'CHECK (singleton)', agent_runtime_auth_admission_check: 'CHECK ((blocked = (purge_id IS NOT NULL)))' },
    },
  } },
];

interface KeyDeclaration { version: number; table: string; kind: string; columns: string[]; reference?: string; referenceColumns?: string[]; deleteAction?: string; }
const keys: KeyDeclaration[] = [
  { version: 56, table: 'agent_runtime_slots', kind: 'p', columns: ['slot'] },
  { version: 56, table: 'agent_runtime_bindings', kind: 'p', columns: ['id'] },
  { version: 56, table: 'agent_runtime_bindings', kind: 'f', columns: ['owner_user_id'], reference: 'auth_users', referenceColumns: ['id'] },
  { version: 56, table: 'agent_runtime_bindings', kind: 'f', columns: ['slot'], reference: 'agent_runtime_slots', referenceColumns: ['slot'], deleteAction: 'a' },
  { version: 56, table: 'agent_runtime_connections', kind: 'p', columns: ['id'] },
  { version: 56, table: 'agent_runtime_connections', kind: 'f', columns: ['owner_user_id'], reference: 'auth_users', referenceColumns: ['id'] },
  { version: 56, table: 'agent_runtime_connections', kind: 'f', columns: ['binding_id'], reference: 'agent_runtime_bindings', referenceColumns: ['id'] },
  { version: 56, table: 'agent_runtime_operator_statements', kind: 'p', columns: ['statement', 'agreed_on'] },
  { version: 58, table: 'agent_runtime_auth_operations', kind: 'p', columns: ['binding_id', 'client'] },
  { version: 58, table: 'agent_runtime_auth_operations', kind: 'u', columns: ['operation_id'] },
  { version: 58, table: 'agent_runtime_auth_operations', kind: 'f', columns: ['binding_id'], reference: 'agent_runtime_bindings', referenceColumns: ['id'] },
  { version: 58, table: 'agent_runtime_auth_operations', kind: 'f', columns: ['owner_user_id'], reference: 'auth_users', referenceColumns: ['id'] },
  { version: 58, table: 'agent_runtime_console_nonces', kind: 'p', columns: ['nonce_digest'] },
  { version: 58, table: 'agent_runtime_console_nonces', kind: 'f', columns: ['owner_user_id'], reference: 'auth_users', referenceColumns: ['id'] },
  { version: 58, table: 'agent_runtime_auth_admission', kind: 'p', columns: ['singleton'] },
];
interface FenceDeclaration { version: number; function: string; body: string; trigger: string; table: string; type: number; columns: string[]; }
const fences: FenceDeclaration[] = [{ version: 58, function: 'invalidate_runtime_auth_operations',
  body: `BEGIN IF NEW.state <> 'active' THEN UPDATE agent_runtime_auth_operations SET phase = 'uncertain', settled_at = NULL
    WHERE binding_id = NEW.id AND phase = 'active'; END IF; RETURN NEW; END`,
  trigger: 'agent_runtime_auth_lifecycle', table: 'agent_runtime_bindings', type: 17, columns: ['state'] }];
const indexes = [
  { version: 56, table: 'agent_runtime_bindings', name: 'agent_runtime_bindings_owner_live_idx', definition: "CREATE UNIQUE INDEX agent_runtime_bindings_owner_live_idx ON SCHEMA.agent_runtime_bindings USING btree (owner_user_id) WHERE (state <> 'released'::text)" },
  { version: 56, table: 'agent_runtime_bindings', name: 'agent_runtime_bindings_slot_live_idx', definition: "CREATE UNIQUE INDEX agent_runtime_bindings_slot_live_idx ON SCHEMA.agent_runtime_bindings USING btree (slot) WHERE (state <> 'released'::text)" },
  { version: 56, table: 'agent_runtime_bindings', name: 'agent_runtime_bindings_owner_idx', definition: 'CREATE INDEX agent_runtime_bindings_owner_idx ON SCHEMA.agent_runtime_bindings USING btree (owner_user_id, created_at DESC, id)' },
  { version: 56, table: 'agent_runtime_connections', name: 'agent_runtime_connections_owner_client_idx', definition: 'CREATE UNIQUE INDEX agent_runtime_connections_owner_client_idx ON SCHEMA.agent_runtime_connections USING btree (owner_user_id, client) WHERE (revoked_at IS NULL)' },
  { version: 58, table: 'agent_runtime_auth_operations', name: 'agent_runtime_auth_expiry_idx', definition: "CREATE INDEX agent_runtime_auth_expiry_idx ON SCHEMA.agent_runtime_auth_operations USING btree (lease_ends_at) WHERE (phase = 'active'::text)" },
];

const undoColumns = ['creation_origin', 'creation_baseline', 'creation_baseline_version', 'creation_proposal_id', 'first_persisted_use_at',
  'creation_reverted_at', 'creation_reverted_by_kind', 'creation_reverted_by_id', 'creation_reversion_notice_id'];
const runtimeTables = [...new Set(declarations.flatMap((declaration) => Object.entries(declaration.tables)
  .filter(([, footprint]) => footprint.exact !== false).map(([table]) => table)))];
const tablesToRead = [...new Set([...declarations.flatMap((declaration) => Object.keys(declaration.tables)), 'notification_preferences', 'project_work_items',
  'task_creation_undo_receipts', 'agent_standing_grants', 'project_task_notices'])];
const functionsToRead = [...new Set([...fences.map((fence) => fence.function), 'flux_guard_task_creation_receipt', 'flux_guard_task_creation_history'])];
const triggersToRead = fences.map((fence) => fence.trigger);

// Whitespace is cosmetic; literals, casts, operators and grouping remain exact.
// In particular, this never removes parentheses or turns CHECK(true) into a valid signature.
function sqlTokens(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^'\s]+/g) ?? []).join('');
}
function refuse(reason: string): never {
  throw new Error(`Flux migration footprint refused: ${reason}. Restore the matching image or database backup; do not edit the ledger by hand. Refusing migration and queue startup.`);
}

interface Relation { name: string; kind: string; inherited: boolean; }
interface ActualColumn { table: string; name: string; type: string; not_null: boolean; default_expression: string | null; identity: string; generated: string; dimensions: number; }
interface Constraint { table: string; name: string; kind: string; validated: boolean; definition: string; columns: string[]; reference_table: string | null; reference_schema: string | null;
  reference_columns: string[]; delete_action: string; update_action: string; match_type: string; deferrable: boolean; deferred: boolean; }

/** Read only the actual catalog. Call before any migration SQL or queue startup. */
export async function assertMigrationFootprint(db: Reader, manifest: readonly MigrationFile[], applied: readonly number[]): Promise<void> {
  assertKnownMigrationVersions(manifest, applied);
  for (const declaration of declarations) {
    const file = manifest.find((file) => file.version === declaration.file.version);
    if (file && file.name !== declaration.file.name) refuse(`image version ${file.version} has unsupported semantics (${file.name})`);
  }
  if (applied.includes(57) && !applied.includes(56)) refuse('sign-in 57 lacks its runtime 56 predecessor');
  if (applied.includes(58) && !applied.includes(57)) refuse('auth 58 lacks its sign-in 57 predecessor');
  // One catalog snapshot: every component sees the same PostgreSQL statement snapshot.
  const result = await db.query(`SELECT
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'inherited',EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid)) ORDER BY c.relname),'[]')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
      AND c.relkind NOT IN ('i','I') AND (c.relname=ANY($1::text[]) OR c.relname LIKE 'agent_runtime_auth_%')) AS relations,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'default_expression',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'dimensions',a.attndims)
      ORDER BY c.relname,a.attnum),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])) AS columns,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'kind',k.contype,'validated',k.convalidated,
      'definition',pg_get_constraintdef(k.oid,false),'columns',ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
        JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord),
      'reference_table',r.relname,'reference_schema',rn.nspname,'reference_columns',ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
        JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord),
      'delete_action',k.confdeltype,'update_action',k.confupdtype,'match_type',k.confmatchtype,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY c.relname,k.conname),'[]')
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_class r ON r.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])) AS constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'body',p.prosrc,'arguments',p.pronargs,'result',format_type(p.prorettype,NULL),
      'language',l.lanname,'security_definer',p.prosecdef,'config',p.proconfig) ORDER BY p.oid),'[]')
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=current_schema()
      AND p.proname=ANY($2::text[])) AS functions,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,'type',t.tgtype,'enabled',t.tgenabled,
      'function',p.proname,'function_schema',pn.nspname,'arguments',t.tgnargs,'condition',t.tgqual::text,
      'columns',ARRAY(SELECT a.attname FROM unnest(t.tgattr::smallint[]) x(num) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num)) ORDER BY t.tgname),'[]')
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND (c.relname=ANY($1::text[]) OR t.tgname=ANY($3::text[]))) AS triggers,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'table',t.relname,'definition',pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready,'nulls_not_distinct',i.indnullsnotdistinct) ORDER BY c.relname),'[]')
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname=ANY($1::text[])) AS indexes,
    current_schema() AS schema`, [tablesToRead, functionsToRead, triggersToRead]);
  const catalog = result.rows[0] as { relations: Relation[]; columns: ActualColumn[]; constraints: Constraint[];
    functions: { name: string; body: string; arguments: number; result: string; language: string; security_definer: boolean; config: unknown }[];
    triggers: { name: string; table: string; type: number; enabled: string; function: string; function_schema: string; arguments: number; condition: string | null; columns: string[] }[];
    indexes: { name: string; table: string; definition: string; valid: boolean; ready: boolean; nulls_not_distinct: boolean }[];
    schema: string };

  const expected = new Map<string, TableFootprint>();
  for (const declaration of declarations.filter((declaration) => applied.includes(declaration.file.version))) {
    if (!manifest.some((file) => file.name === declaration.file.name)) refuse(`recorded ${declaration.file.name} has no matching image declaration`);
    for (const [table, footprint] of Object.entries(declaration.tables)) {
      const previous = expected.get(table) ?? { columns: [], checks: {} };
      expected.set(table, { columns: [...previous.columns, ...footprint.columns], checks: { ...previous.checks, ...footprint.checks }, exact: footprint.exact ?? previous.exact });
    }
  }
  // A future owner may declare 48/59/60 here with its tables/keys/fences and real controls.
  // The present image declares none: neither a renamed SQL file nor a legacy number admits it.
  const undeclared = manifest.find((file) => [48, 59, 60].includes(file.version) && !declarations.some((declaration) => declaration.file.name === file.name));
  if (undeclared) refuse(`this image has no catalog descriptor for ${undeclared.name}`);
  const legacyColumn = catalog.columns.find((column) => ((column.table === 'notification_preferences' && column.name === 'paused_until') ||
    (column.table === 'project_work_items' && undoColumns.includes(column.name))) && !expected.get(column.table)?.columns.some(([name]) => name === column.name));
  const legacyRelation = catalog.relations.find((relation) => relation.name === 'task_creation_undo_receipts' && !expected.has(relation.name));
  const legacyConstraint = catalog.constraints.find((constraint) => ((constraint.table === 'agent_standing_grants' && constraint.definition.includes("'work.creation.revert'")) ||
    (constraint.table === 'project_task_notices' && constraint.definition.includes("'task.creation_reverted'"))) &&
    sqlTokens(constraint.definition) !== sqlTokens(expected.get(constraint.table)?.checks[constraint.name] ?? ''));
  if (legacyColumn || legacyRelation || legacyConstraint) refuse(`unowned focus/Undo catalog object ${legacyColumn ? `${legacyColumn.table}.${legacyColumn.name}` : legacyRelation?.name ?? legacyConstraint?.name}`);
  for (const relation of catalog.relations.filter((relation) => runtimeTables.includes(relation.name) || relation.name.startsWith('agent_runtime_auth_'))) {
    if (!expected.has(relation.name)) refuse(`untracked table ${relation.name}`);
    if (relation.kind !== 'r' || relation.inherited) refuse(`${relation.name} is not an ordinary non-inherited table`);
  }
  for (const [table, footprint] of expected) {
    if (!catalog.relations.some((relation) => relation.name === table)) refuse(`missing table ${table}`);
    const columns = catalog.columns.filter((column) => column.table === table);
    if (footprint.exact !== false && columns.length !== footprint.columns.length) refuse(`${table} has a partial or additional column footprint`);
    for (const [name, type, notNull, defaultExpression] of footprint.columns) {
      const actual = columns.find((column) => column.name === name);
      if (!actual || actual.type !== type || actual.not_null !== notNull || actual.identity || actual.generated || actual.dimensions !== 0 ||
        sqlTokens(actual.default_expression ?? '') !== sqlTokens(defaultExpression ?? '')) refuse(`${table}.${name} has a missing or unexpected type/nullability/default`);
    }
    const checks = catalog.constraints.filter((constraint) => constraint.table === table && constraint.kind === 'c');
    if (footprint.exact !== false && checks.length !== Object.keys(footprint.checks).length) refuse(`${table} has a partial or additional CHECK footprint`);
    for (const [name, definition] of Object.entries(footprint.checks)) {
      const actual = checks.find((constraint) => constraint.name === name);
      if (!actual?.validated || sqlTokens(actual.definition) !== sqlTokens(definition)) refuse(`${table}.${name} is missing, unvalidated or has unexpected CHECK semantics`);
    }
  }
  // Correctly named but absent/altered keys or fences do not establish a valid footprint.
  for (const { table, kind, columns, reference, referenceColumns, deleteAction } of keys.filter((key) => applied.includes(key.version))) {
    const actual = catalog.constraints.find((constraint) => constraint.table === table && constraint.kind === kind &&
      constraint.columns.join(',') === columns.join(',') && constraint.reference_table === (reference ?? null) && constraint.reference_columns.join(',') === (referenceColumns ?? []).join(','));
    if (!actual?.validated || actual.deferrable || actual.deferred || (kind === 'f' && (actual.delete_action !== (deleteAction ?? 'c') || actual.update_action !== 'a' ||
      actual.match_type !== 's' || actual.reference_schema !== catalog.schema))) {
      refuse(`${table} has a missing or altered ${kind} key for ${columns.join(',')}`);
    }
  }
  for (const index of indexes.filter((index) => applied.includes(index.version))) {
    const actual = catalog.indexes.find((actual) => actual.name === index.name && actual.table === index.table);
    // pg_get_indexdef always schema-qualifies its table; deployed Flux schema names use bare identifiers.
    const schema = /^[a-z_][a-z0-9_]*$/.test(catalog.schema) ? catalog.schema : `"${catalog.schema.replaceAll('"', '""')}"`;
    if (!actual?.valid || !actual.ready || actual.nulls_not_distinct || sqlTokens(actual.definition) !== sqlTokens(index.definition.replace('SCHEMA', schema))) {
      refuse(`missing or altered index ${index.name}`);
    }
  }
  const activeFences = fences.filter((fence) => applied.includes(fence.version));
  for (const fn of catalog.functions) if (!activeFences.some((fence) => fence.function === fn.name)) refuse(`untracked function ${fn.name}`);
  for (const actual of catalog.triggers.filter((trigger) => triggersToRead.includes(trigger.name))) {
    if (!activeFences.some((fence) => fence.trigger === actual.name)) refuse(`untracked trigger ${actual.name}`);
  }
  for (const fence of activeFences) {
    const functions = catalog.functions.filter((fn) => fn.name === fence.function);
    if (functions.length !== 1 || functions[0]!.arguments !== 0 || functions[0]!.result !== 'trigger' || functions[0]!.language !== 'plpgsql' ||
      functions[0]!.security_definer || functions[0]!.config !== null || sqlTokens(functions[0]!.body) !== sqlTokens(fence.body)) refuse(`missing or altered lifecycle function ${fence.function}`);
    const triggers = catalog.triggers.filter((trigger) => trigger.name === fence.trigger);
    const trigger = triggers[0];
    if (triggers.length !== 1 || !trigger || trigger.table !== fence.table || trigger.type !== fence.type || trigger.enabled !== 'O' ||
      trigger.function !== fence.function || trigger.function_schema !== catalog.schema || trigger.arguments !== 0 || trigger.condition !== null ||
      trigger.columns.join(',') !== fence.columns.join(',')) refuse(`missing, disabled or altered lifecycle trigger ${fence.trigger}`);
  }
}
