import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createDatabase } from '@flux/db';
import { chromium } from 'playwright';
import { register, uniqueEmail } from '../support/http.js';
import { password } from '../support/people.js';
import { expect } from '../support/mcp.js';
import { claudeBin, cleanClientHome, clientEvents, connectClient, scopes, seedOauthClient, sh, startFluxProxy,
  type ClientSpec } from '../support/mcp-client-harness.js';

// OPT IN ONLY. Official pinned clients and their configured model accounts, never a scripted endpoint.
// Credentials are mounted read-only from explicit host paths into a disposable container. No transcript or
// credential content is printed. The project contains only this fixture, and the person's input is Start/Resume.
// This proves only the behavior actually asserted below; it is not idle-wake or complete #160 acceptance.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000); });
test('real configured accounts: supplied Start and Resume reach the model and produce authorized native work',
  { skip: process.env.FLUX_TEST_MCP_LIVE_WORKFLOW !== '1' }, async (t) => {
    const { pool } = createDatabase(process.env.DATABASE_URL!);
    const proxy = startFluxProxy(); await proxy.listen();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      for (const client of ['codex', 'claude'] as const) await t.test(client, async () => {
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
        const home = cleanClientHome(spec);
        delete home.env.MOCK_MODEL_KEY; delete home.env.ANTHROPIC_API_KEY; home.env.RUST_LOG = 'warn';
        if (client === 'codex') symlinkSync('/run/flux-live/codex-auth.json', join(home.env.CODEX_HOME!, 'auth.json'));
        else symlinkSync('/run/flux-live/claude-credentials.json', join(home.env.CLAUDE_CONFIG_DIR!, '.credentials.json'));
        await connectClient(browser, email, home, await seedOauthClient(pool, spec));
        async function invoke(action: 'start' | 'resume') {
          const input = client === 'claude' ? `/mcp__flux__${action}_work ${projectId}` : `${action === 'start' ? 'Start' : 'Resume'} work on Flux`;
          const result = client === 'codex'
            ? await sh('codex', ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', input], home.env, home.cwd)
            : await sh(claudeBin, ['-p', input, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__flux', '--max-turns', '20'], home.env, home.cwd);
          const failure = /usage_limit|rate_limit|rate limit|weekly limit|authentication_error|401 Unauthorized|not logged in/i.test(result.output);
          assert.ok(!failure, `${client}: configured-account authentication or usage limit; stop this provider, do not retry or substitute a payer`);
          assert.equal(result.code, 0, `${client}: native ${action} did not finish within the bounded invocation`);
          const events = clientEvents(result.output);
          const names = new Set<string>();
          for (const event of events) {
            if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') names.add(String(event.item.tool));
            for (const block of event.message?.content ?? []) if (block.type === 'tool_use') names.add(String(block.name));
          }
          console.log('LIVE_NATIVE_WORKFLOW_TURN', JSON.stringify({ client, action, tools: [...names].sort() }));
        }
        await invoke('start');
        const tasks = (await pool.query(`SELECT w.id,w.criteria,i.intent_key FROM project_work_items w
          LEFT JOIN project_task_plan_intents i ON i.task_id=w.id WHERE w.project_id=$1 AND w.creation_reverted_at IS NULL`, [projectId])).rows;
        assert.equal(tasks.length, 1, `${client}: Start must create exactly one native task from the plan`);
        assert.ok(tasks[0].criteria.length > 0 && tasks[0].intent_key, `${client}: task has criteria and a plan-intent correlation`);
        const checkpoints = (await pool.query(`SELECT c.progress FROM cowork_checkpoints c JOIN cowork_units u ON u.id=c.unit_id
          WHERE c.project_id=$1 AND u.assignment_connection_id=$2 AND u.state='paused'`, [projectId, connection.id])).rows;
        assert.ok(checkpoints.some(row => row.progress.orientation?.known?.length > 0), `${client}: Start persists actual source coverage at a safe checkpoint`);
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
    } finally { await browser.close(); await proxy.close(); await pool.end(); }
  });
