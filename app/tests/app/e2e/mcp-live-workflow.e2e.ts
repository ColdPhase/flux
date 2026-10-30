import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { coworkHostScope, coworkHostUrl, coworkNativeOutcome, type CoworkHostBinding } from '../../../tooling/cowork.js';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { expect } from '../support/mcp.js';
import { coworkProductionInvoke, coworkProductionLogin } from '../support/cowork-production-invoke.js';
import { createOAuthDiagnostic, oauthComparisonOnly, oauthDefaultCallbackOnly, oauthLoginOnly, oauthPrivateCallback, oauthProductionFirstLoginOnly } from '../support/oauth-diagnostics.js';
import { authorizeInBrowser, claudeBin, cleanClientHome, clientEvents, connectClient, origin, run, scopes, seedOauthClient, sh, startFluxProxy, waitFor,
  type ClientSpec } from '../support/mcp-client-harness.js';

// OPT IN ONLY. Official pinned clients and their configured model accounts, never a scripted endpoint.
// Credentials are mounted read-only from explicit host paths into a disposable container. No transcript or
// credential content is printed. The project contains only this fixture, and the person's input is Start/Resume.
// This proves only the behavior actually asserted below; it is not idle-wake or complete #160 acceptance.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });
test('real configured accounts: supplied Start and Resume reach the model and produce authorized native work',
  { skip: process.env.FLUX_TEST_MCP_LIVE_WORKFLOW !== '1' }, async (t) => {
    const loginOnly = oauthLoginOnly(process.env);
    const compare = oauthComparisonOnly(process.env);
    const defaultCallback = oauthDefaultCallbackOnly(process.env);
    const productionFirst = oauthProductionFirstLoginOnly(process.env);
    let diagnostic = createOAuthDiagnostic();
    const { pool } = createDatabase(process.env.DATABASE_URL!);
    // Every client request to Flux passes this proxy; the quiet-idle window below counts them (#160 AC-4).
    let fluxRequests = 0;
    const proxy = startFluxProxy(observation => diagnostic.response(observation), () => { fluxRequests++; }); await proxy.listen();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const only = process.env.FLUX_TEST_MCP_LIVE_CLIENT;
      assert.ok(!only || only === 'codex' || only === 'claude', 'FLUX_TEST_MCP_LIVE_CLIENT selects codex or claude');
      for (const client of ['codex', 'claude'] as const) {
        if (only && only !== client) continue;
        await t.test(client, async () => {
        const startedAt = Date.now();
        const spec: ClientSpec = { key: `live-${client}`, client, label: `Live ${client}`, designation: client === 'codex' ? 'codex' : 'claude_code',
          port: client === 'codex' ? 19831 : 19832 };
        const email = uniqueEmail(`live-${client}`); const { browser: owner } = await register(email, password, 'Workflow fixture owner');
        const ws = expect(await owner.request('POST', '/api/v1/workspaces', { body: { name: 'Live workflow fixture' } }), 201);
        const project = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/projects`,
          { body: { name: 'Non-code orientation study', visibility: 'restricted' } }), 201);
        const projectId = String(project.id);
        const plan = expect(await owner.request('POST', `/api/v1/projects/${projectId}/materials`, { body: {
          clientMutationId: randomUUID(), title: 'Current project plan', body: 'Outcome: compare the two proposed labels, Study and Research. '
            + 'Create one native task for this comparison, with criteria that the chosen label and reason are recorded. '
            + 'Do not change software or contact anyone. The wiki explains the audience.' } }), 201);
        expect(await owner.request('POST', `/api/v1/projects/${projectId}/docs`,
          { body: { title: 'Audience', body: 'This workspace is for people recording small experiments; use familiar everyday language.' } }), 201);
        expect(await owner.request('PUT', `/api/v1/projects/${projectId}/agent-policy`, { body: {
          expectedRevision: 0, scope: 'Only this isolated non-code label-comparison study.', priorities: 'Read the current plan and relevant wiki, decisions, conversations and existing tasks first. '
            + 'Create exactly one task for the plan with source-linked criteria and a stable plan intent; do not duplicate it on Resume.',
          reviewCriteria: 'A sourced, concise comparison; no unsupported external claims.',
          allowedWork: 'Within the granted actions, take and claim the task, then pause it with a checkpoint containing observed source coverage and missing context. '
            + 'Leave the task open for a later result. On Resume compare source versions, reread any changed plan, and record a native result explaining the current plan. '
            + 'Stop after that bounded step. Never use another account, modify software or send external messages.' } }), 201);
        const agent = expect(await owner.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
          { body: { name: spec.label, owner: 'self' } }), 201);
        expect(await owner.request('POST', `/api/v1/projects/${projectId}/grants`,
          { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
        const connection = expect(await owner.request('POST', '/api/v1/agent-connections', { body: {
          name: spec.label, clientDesignation: spec.designation, agentId: agent.id, selectedProjectIds: [projectId], scopes } }), 201);
        for (const operation of ['work.create', 'cowork.unit.create', 'cowork.claim', 'cowork.release', 'result.record']) {
          expect(await owner.request('POST', `/api/v1/agent-connections/${connection.id}/action-grants`, { body: {
            clientCommandId: randomUUID(), projectId, operation, peerRequestClass: 'execute', maximumUses: 5,
            expiresAt: new Date(Date.now() + 1_800_000).toISOString() } }), 201);
        }
        const home = cleanClientHome(spec, { oauthFileStore: !productionFirst });
        delete home.env.MOCK_MODEL_KEY; delete home.env.ANTHROPIC_API_KEY; home.env.RUST_LOG = 'warn';
        if (loginOnly) {
          for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']) home.env[key] = '';
        }
        if (!loginOnly) {
          // A private writable copy in this disposable HOME: the client may refresh an expired access token there.
          // The read-only host file is never written, and the copy is removed with the container.
          const target = client === 'codex' ? join(home.env.CODEX_HOME!, 'auth.json') : join(home.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
          copyFileSync(client === 'codex' ? '/run/flux-live/codex-auth.json' : '/run/flux-live/claude-credentials.json', target);
          chmodSync(target, 0o600);
        }
        let binding: CoworkHostBinding = { schema: 'flux.cowork.host/1', ...coworkHostScope(origin, String(connection.id), projectId, 'codex', home.cwd),
          threadId: null, outcome: 'new', updatedAt: new Date().toISOString() };
        const config = ['-c', `mcp_servers.flux.url=${JSON.stringify(coworkHostUrl(binding))}`,
          '-c', 'mcp_servers.flux.required=true'];
        // The actual production first-login path relies solely on native CIMD/discovery. No seeded client or add.
        const clientId = productionFirst ? undefined : await seedOauthClient(pool, spec);
        const fixtureConfig = [...config, '-c', `mcp_servers.flux.oauth.client_id=${JSON.stringify(clientId)}`,
          '-c', `mcp_oauth_callback_port=${spec.port}`, ...(defaultCallback ? [] : ['-c', `mcp_servers.flux.oauth.callback_url=${JSON.stringify(`http://127.0.0.1:${spec.port}/callback`)}`]),
          '-c', 'mcp_oauth_credentials_store="file"'];
        if (client === 'codex') {
          const variants = productionFirst ? ['production_first_login'] as const : compare ? ['persisted_bound', 'inline_bound'] as const
            : defaultCallback ? ['inline_bound'] as const : ['persisted_bound'] as const;
          const outcomes: boolean[] = [];
          for (const variant of variants) {
            diagnostic = createOAuthDiagnostic();
            // Same fixture registration/connection/callback port; each configuration gets a fresh writable native HOME.
            const target = compare ? cleanClientHome({ ...spec, key: `${spec.key}-${variant}` }) : home;
            if (compare) {
              for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'MOCK_MODEL_KEY']) target.env[key] = '';
              target.env.RUST_LOG = 'warn';
              // Reset only this newly seeded fixture client's consent, so both legs exercise consent instead of a cached approval.
              await pool.query('DELETE FROM oauth_consent WHERE client_id=$1', [clientId]);
            }
            diagnostic.browser({ stage: 'native_login_started' });
            let login = run('codex', variant === 'production_first_login' ? coworkProductionLogin(binding) : variant === 'persisted_bound'
              ? ['mcp', 'add', 'flux', '--url', coworkHostUrl(binding), '--oauth-client-id', clientId!, '-c', `mcp_oauth_callback_port=${spec.port}`]
              : [...fixtureConfig, 'mcp', 'login', 'flux', '--no-browser'], target.env, target.cwd);
            let exitCode: number | null = null;
            try {
              const pattern = /(https?:\/\/[^\s"']*\/api\/auth\/oauth2\/authorize\?[^\s"']+)/;
              let match: RegExpMatchArray;
              try { match = await waitFor(login, pattern, 'bound adapter OAuth'); }
              catch {
                if (variant !== 'persisted_bound' || await login.done !== 0) throw new Error('Native authorization was not offered.');
                // Exact successful #612 add/login fallback composition, still only within this isolated fixture HOME.
                login = run('codex', ['mcp', 'login', 'flux', '--no-browser', '-c', `mcp_oauth_callback_port=${spec.port}`], target.env, target.cwd);
                match = await waitFor(login, pattern, 'persisted bound OAuth');
              }
              diagnostic.browser({ stage: 'authorization_received' });
              const callback = productionFirst ? oauthPrivateCallback(match[1]!) : undefined;
              const callbackSpec = callback ? { ...spec, port: Number(callback.port || 80) } : spec;
              await authorizeInBrowser(browser, email, callbackSpec, match[1]!, diagnostic.browser, diagnostic.callback, callback);
              exitCode = await login.done;
            } catch { login.kill(); exitCode = await login.done; }
            finally {
              diagnostic.browser({ stage: 'native_login_finished' });
              console.log('LIVE_NATIVE_OAUTH_DIAGNOSTIC', JSON.stringify({ configuration: defaultCallback ? 'inline_bound_default_callback' : variant, ...diagnostic.report(login.output(), exitCode) }));
            }
            outcomes.push(exitCode === 0);
          }
          assert.ok(outcomes.every(Boolean), 'Bound Codex OAuth did not complete; inspect LIVE_NATIVE_OAUTH_DIAGNOSTIC only.');
          if (loginOnly) {
            const tasks = await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1', [projectId]);
            assert.equal(tasks.rows[0].n, 0, 'login-only ends before native workflow execution or model-created tasks');
            console.log('LIVE_NATIVE_OAUTH_LOGIN_ONLY_COMPLETE');
            return;
          }
        } else await connectClient(browser, email, home, clientId);
        // This native thread belongs only to this fresh fixture HOME and immutable connection/project.
        // Never consult the person's global history or use --last to select it.
        let codexThreadId: string | null = null;
        async function invoke(action: 'start' | 'resume') {
          assert.equal(loginOnly, false, 'login-only diagnosis must never invoke a model');
          const input = client === 'claude' ? `/mcp__flux__${action}_work ${projectId}` : `${action === 'start' ? 'Start' : 'Resume'} work on Flux`;
          if (client === 'codex' && action === 'resume') assert.ok(codexThreadId, 'Resume needs the exact thread issued by this fixture’s Start');
          const result = client === 'codex'
            ? await sh('codex', coworkProductionInvoke(binding, action), home.env, home.cwd)
            : await sh(claudeBin, ['-p', input, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '20'], home.env, home.cwd);
          // Only a failed run is an account stop. Claude's stream-json carries routine `rate_limit_event` status lines
          // in a successful run, so markers are read from its final result (or from a failed process's output) only.
          const parsed = clientEvents(result.output) as Array<Record<string, unknown>>;
          const final = parsed.filter(event => event.type === 'result').at(-1);
          const failedText = client === 'claude'
            ? (final?.is_error === true || result.code !== 0 ? `${String(final?.result ?? '')} ${String(final?.subtype ?? '')}${final ? '' : result.output}` : '')
            : (result.code !== 0 ? result.output : parsed.filter(event => event.type === 'error' || event.type === 'turn.failed').map(event => JSON.stringify(event)).join(' '));
          const categories = ['usage_limit', 'rate_limit', 'rate limit', 'weekly limit', 'authentication_error', '401 Unauthorized', 'not logged in']
            .filter(marker => failedText.toLowerCase().includes(marker.toLowerCase()));
          const failure = categories.length > 0;
          if (failure) console.log('LIVE_NATIVE_ACCOUNT_STOP', JSON.stringify({ client, action, categories }));
          assert.ok(!failure, `${client}: configured-account authentication or usage limit; stop this provider, do not retry or substitute a payer`);
          assert.equal(result.code, 0, `${client}: native ${action} did not finish within the bounded invocation`);
          if (client === 'codex') {
            const eventsPath = join(home.cwd, 'private-native-events.jsonl');
            try {
              await writeFile(eventsPath, result.output, { mode: 0o600 });
              const recorded = await coworkNativeOutcome(eventsPath, binding, result.code ?? 1);
              assert.equal(recorded.binding.outcome, 'waiting', 'supplied adapter captures only its own resumable native thread');
              binding = recorded.binding;
            } finally { await unlink(eventsPath).catch(() => undefined); }
          }
          const events = clientEvents(result.output);
          if (client === 'codex' && action === 'start') {
            const native = events.find(event => event.type === 'thread.started') as { thread_id?: string } | undefined;
            assert.ok(native?.thread_id && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(native.thread_id), 'Start must report its own native thread ID');
            codexThreadId = native.thread_id;
          }
          const calls: string[] = [];
          for (const event of events) {
            if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') calls.push(String(event.item.tool));
            for (const block of event.message?.content ?? []) if (block.type === 'tool_use') calls.push(String(block.name));
          }
          // Fixture-only diagnostics: failed tool names/statuses and a bounded excerpt of the model's last message on this
          // disposable fixture project (no person's content), so a stop before the expected effect can be explained.
          const failed: string[] = [];
          let lastMessage = '';
          type Seen = { type?: string; result?: unknown; item?: { type?: string; tool?: string; status?: string; text?: string; error?: { message?: string } };
            message?: { content?: { type?: string; is_error?: boolean; content?: unknown }[] } };
          for (const event of events as Seen[]) {
            if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.status !== 'completed')
              failed.push(`${event.item.tool}:${event.item.status}:${String(event.item.error?.message ?? '').slice(0, 160)}`);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = String(event.item.text ?? '');
            if (event.type === 'user') for (const block of event.message?.content ?? []) if (block.type === 'tool_result' && block.is_error)
              failed.push(`tool_result_error:${JSON.stringify(block.content).slice(0, 160)}`);
            if (event.type === 'result') lastMessage = String(event.result ?? '');
          }
          console.log('LIVE_NATIVE_WORKFLOW_TURN', JSON.stringify({ client, action, exit: result.code, toolCalls: calls.length, tools: [...new Set(calls)].sort(),
            failedCalls: failed.slice(0, 10), lastMessage: lastMessage.slice(0, 600) }));
        }
        await invoke('start');
        const tasks = (await pool.query(`SELECT w.id,w.criteria,i.intent_key FROM project_work_items w
          LEFT JOIN project_task_plan_intents i ON i.task_id=w.id WHERE w.project_id=$1 AND w.creation_reverted_at IS NULL`, [projectId])).rows;
        assert.equal(tasks.length, 1, `${client}: Start must create exactly one native task from the plan`);
        assert.ok(tasks[0].criteria.length > 0 && tasks[0].intent_key, `${client}: task has criteria and a plan-intent correlation`);
        const checkpoints = (await pool.query(`SELECT c.progress FROM cowork_checkpoints c JOIN cowork_units u ON u.id=c.unit_id
          WHERE c.project_id=$1 AND u.assignment_connection_id=$2 AND u.state='paused'`, [projectId, connection.id])).rows;
        assert.ok(checkpoints.some(row => row.progress.orientation?.known?.length > 0), `${client}: Start persists actual source coverage at a safe checkpoint`);
        // Quiet idle (#160 AC-4): after Start's bounded turn the client holds no process and makes no request to Flux
        // or a model until the person's next supplied action. Count every proxied Flux request over a fixed window.
        const idleFrom = fluxRequests; const idleMs = Number(process.env.FLUX_TEST_MCP_IDLE_MS ?? 60_000);
        await new Promise((resolve) => setTimeout(resolve, idleMs));
        const idleRequests = fluxRequests - idleFrom;
        console.log('LIVE_NATIVE_QUIET_IDLE', JSON.stringify({ client, windowMs: idleMs, fluxRequests: idleRequests, clientProcesses: 0 }));
        assert.equal(idleRequests, 0, `${client}: no Flux request while idle between Start and Resume`);
        expect(await owner.request('PATCH', `/api/v1/materials/${plan.materialId}`, { body: {
          clientMutationId: randomUUID(),
          title: 'Current project plan', body: 'Changed outcome: use Experiment as the label, because the audience records small experiments.',
          expectedVersion: Number(plan.version) } }), 200);
        await invoke('resume');
        const counts = (await pool.query('SELECT count(*)::int AS n FROM project_work_items WHERE project_id=$1 AND creation_reverted_at IS NULL', [projectId])).rows;
        assert.equal(counts[0].n, 1, `${client}: Resume uses existing work instead of duplicating the task`);
        const results = (await pool.query('SELECT evidence FROM project_results WHERE project_id=$1', [projectId])).rows;
        assert.ok(results.some(row => /Experiment/i.test(row.evidence)), `${client}: Resume records evidence of the changed plan`);
        const acks = (await pool.query(`SELECT a.version FROM agent_playbook_acknowledgments a
          JOIN agent_runtime_sessions r ON r.id=a.runtime_session_id WHERE r.connection_id=$1`, [connection.id])).rows;
        assert.ok(acks.length >= 1, `${client}: real model acknowledged the supplied bundle`);
        console.log('LIVE_NATIVE_WORKFLOW_RESULT', JSON.stringify({ client, elapsedMs: Date.now() - startedAt,
          tasks: 1, durableOrientation: true, changedPlanResult: true, projectId, connectionId: connection.id }));
        });
      }
    } finally { await browser.close(); await proxy.close(); await pool.end(); }
  });
