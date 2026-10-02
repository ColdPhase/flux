import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase, FLUX_SCHEMA_VERSION, readMigrationManifest } from '@flux/db';

const dir = 'packages/db/migrations';

// 0042 (#179, F-020): relaxes the Anthropic-only pins of 0027/0024 for provider-neutral connections,
// keeps every earlier row as it was (with its model's dated table price), and reverses only before use.
test('0042 keeps earlier connections and consents, enforces the new shape, and reverses only before use', async () => {
  const manifest = await readMigrationManifest(dir, FLUX_SCHEMA_VERSION);
  const migration = manifest.find((file) => file.version === 42);
  assert.equal(migration?.name, '0042_ai_provider_connections.sql');
  const name = `flux_ai_history_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(process.env.DATABASE_URL!).pool;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  let history: ReturnType<typeof createDatabase>['pool'] | undefined;
  try {
    // Database administration and the full history can outlast the pool's short default deadline.
    const createFixture = { text: `CREATE DATABASE "${name}"`, query_timeout: 60_000 };
    await admin.query(createFixture);
    history = createDatabase(url.toString()).pool;
    for (const file of manifest.filter((file) => file.version < 42)) {
      const step = { text: await readFile(join(dir, file.name), 'utf8'), query_timeout: 60_000 };
      await history.query(step);
    }
    const user = 'historic-owner';
    const legacy = randomUUID();
    await history.query('INSERT INTO auth_users(id,name,email) VALUES($1,$2,$3)', [user, 'Historic owner', 'ai-history@example.test']);
    await history.query(`INSERT INTO background_compute_connections(id,owner_user_id,provider,model,payer_organization,provider_workspace,
      encrypted_key,key_last_four,key_fingerprint,max_runs_per_day,period_days,period_budget_cents,per_run_cents,consent_version)
      VALUES($1,$2,'anthropic','claude-sonnet-5','Payer org','Workspace','v1.cipher','ABCD','0123456789abcdef',1,30,50,5,'o-007-2026-09-28')`, [legacy, user]);
    await history.query(`INSERT INTO personal_run_enablements(owner_user_id,connection_id,consent_version,consent_provider,consent_model,
      consent_payer_organization,consent_payer_workspace) VALUES($1,$2,'o-008-2026-09-28','anthropic','claude-sonnet-5','Payer org','Workspace')`, [user, legacy]);
    const keep = async () => ({
      connection: (await history!.query(`SELECT id, owner_user_id, provider, model, encrypted_key, key_last_four, key_fingerprint, consent_version,
        per_run_cents FROM background_compute_connections`)).rows,
      enablement: (await history!.query('SELECT owner_user_id, connection_id, consent_version, consent_provider, consent_model FROM personal_run_enablements')).rows,
    });
    const before = await keep();

    await history.query(await readFile(join(dir, migration!.name), 'utf8'));
    assert.deepEqual(await keep(), before, 'no earlier connection or consent is rewritten');
    assert.deepEqual((await history.query(`SELECT base_url, input_price_micros_per_mtok, output_price_micros_per_mtok, price_source,
      to_char(price_checked_on, 'YYYY-MM-DD') AS checked FROM background_compute_connections`)).rows,
    [{ base_url: null, input_price_micros_per_mtok: 2_000_000, output_price_micros_per_mtok: 10_000_000, price_source: 'table', checked: '2026-09-28' }],
    'the O-007 rate recorded on 2026-09-28 becomes the earlier connection\'s table price');
    for (const [table, column] of [['personal_runs', 'provider'], ['proactive_comparison_proposals', 'provider'], ['proactive_comparison_proposals', 'model']]) {
      const info: unknown = (await history.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column])).rows[0];
      assert.deepEqual(info, { is_nullable: 'NO', column_default: null }, `${table}.${column} is required and set explicitly by every writer`);
    }

    // Probe rows are revoked (no ciphertext), so the one-active-connection index plays no part; each probe rolls back.
    const insert = (fields: Record<string, unknown>) => history!.query(`INSERT INTO background_compute_connections(id,owner_user_id,provider,model,base_url,
      payer_organization,provider_workspace,encrypted_key,revoked_at,key_last_four,key_fingerprint,max_runs_per_day,period_days,period_budget_cents,per_run_cents,
      consent_version,input_price_micros_per_mtok,output_price_micros_per_mtok,price_source,price_checked_on)
      VALUES($1,$2,$3,$4,$5,'Payer org','Workspace',NULL,now(),'ABCD','0123456789abcdef',1,30,50,5,$6,$7,$8,$9,$10)`,
    [randomUUID(), user, fields.provider ?? 'openai', fields.model ?? 'gpt-model', fields.baseUrl ?? null, fields.consent ?? 'o-007-2026-10-02',
      'input' in fields ? fields.input : 400_000, 'output' in fields ? fields.output : 1_600_000, 'source' in fields ? fields.source : 'owner',
      'checked' in fields ? fields.checked : null]);
    const probe = async (fields: Record<string, unknown>) => {
      await history!.query('BEGIN');
      try { await insert(fields); } finally { await history!.query('ROLLBACK'); }
    };
    const valid: Record<string, unknown>[] = [
      { provider: 'openai', model: 'gpt-model' },
      { provider: 'openrouter', model: 'vendor/model:free', source: 'provider_reported', checked: '2026-10-02' },
      { provider: 'gemini', model: 'gemini-model', input: null, output: null, source: null },
      { provider: 'openai_compatible', model: 'llama3.1:8b', baseUrl: 'http://ollama:11434/v1', input: 0, output: 0 },
      { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'table', checked: '2026-10-02' },
    ];
    const invalid: [Record<string, unknown>, RegExp][] = [
      [{ provider: 'mistral' }, /provider_check/],
      [{ model: 'two words' }, /model_check/],
      [{ consent: 'o-007-2026-09-28' }, /legacy_consent_check/],
      [{ consent: 'o-007-2099-01-01' }, /consent_version_check/],
      [{ provider: 'openai_compatible', model: 'llama3.1:8b' }, /base_url_check/],
      [{ baseUrl: 'https://api.openai.com/v1' }, /base_url_check/],
      [{ provider: 'openai_compatible', baseUrl: 'https://user:pw@host/v1' }, /base_url_check/],
      [{ provider: 'openai_compatible', baseUrl: 'https://host/v1?x=1' }, /base_url_check/],
      [{ input: null }, /price_check/],
      [{ source: 'table' }, /price_check/],
      [{ input: -1 }, /check/],
      [{ output: 1_000_000_001 }, /check/],
    ];
    for (const fields of valid) await probe(fields);
    for (const [fields, error] of invalid) await assert.rejects(probe(fields), error, JSON.stringify(fields));
    const enablement = (version: string, provider: string) => history!.query(`UPDATE personal_run_enablements SET consent_version=$1, consent_provider=$2 WHERE owner_user_id=$3`, [version, provider, user]);
    await history.query('BEGIN');
    await enablement('o-008-2026-10-02', 'openrouter');
    await history.query('ROLLBACK');
    await assert.rejects(enablement('o-008-2026-09-28', 'openai'), /legacy_consent_check/);
    await assert.rejects(enablement('o-008-2026-10-02', 'mistral'), /consent_provider_check/);

    // Pre-use reversal restores the previous shape and data; re-applying works again.
    const reverse = await readFile(join(dir, 'reverse', '0042_ai_provider_connections.down.sql'), 'utf8');
    await history.query(reverse);
    assert.deepEqual(await keep(), before);
    assert.equal((await history.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='background_compute_connections' AND column_name IN ('base_url','price_source')")).rows[0].n, 0);
    await assert.rejects(history.query("UPDATE personal_run_enablements SET consent_version='o-008-2026-10-02'"), /consent_version_check/);
    await history.query(await readFile(join(dir, migration!.name), 'utf8'));
    assert.deepEqual(await keep(), before);

    // After real use the previous schema cannot represent the data: the reversal refuses and changes nothing.
    await history.query("UPDATE background_compute_connections SET encrypted_key=NULL, revoked_at=now()");
    await history.query(`INSERT INTO background_compute_connections(id,owner_user_id,provider,model,payer_organization,provider_workspace,
      encrypted_key,key_last_four,key_fingerprint,max_runs_per_day,period_days,period_budget_cents,per_run_cents,consent_version,
      input_price_micros_per_mtok,output_price_micros_per_mtok,price_source)
      VALUES($1,$2,'openai','gpt-model','Payer org','Workspace','v1.cipher','ABCD','0123456789abcdef',1,30,50,5,'o-007-2026-10-02',1,1,'owner')`, [randomUUID(), user]);
    await assert.rejects(history.query(reverse), /reversal refused: provider-neutral background connections exist/);
    assert.equal((await history.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='background_compute_connections' AND column_name='base_url'")).rows[0].n, 1);
  } finally {
    await history?.end();
    const cleanup = { text: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, query_timeout: 60_000 };
    await admin.query(cleanup);
    await admin.end();
  }
});
