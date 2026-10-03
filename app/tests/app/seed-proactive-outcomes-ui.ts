import { comparisonDispatchFixtureDue } from './support/comparison-dispatch-fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDatabase } from '@flux/db';
import type { ComparisonProvider } from '@flux/core';
import { dispatchProactiveComparison } from '../../apps/worker/src/proactive-comparison/dispatch.js';
import { addMember, expectStatus, grant, password, person, project, workspace } from './support/people.js';

const { db, pool } = createDatabase(process.env.DATABASE_URL!);
try {
  const owner = await person('outcome-ui-owner');
  const viewer = await person('outcome-ui-viewer');
  const ws = await workspace(owner, 'Lamp measurement studio');
  await addMember(owner, ws.id, viewer, 'member');
  const prj = await project(owner, ws.id, 'Bedside gesture lamp', 'restricted');
  await grant(owner, prj.id, viewer, 'viewer');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Lamp comparison assistant', owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`,
    { body: { agentId: agent.id, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal', maxRunsPerDay: 3, periodBudgetCents: 50, perRunCents: 5 } }), 201) as { id: string };
  const connection = expectStatus(await owner.browser.request('POST', '/api/v1/background-compute-connections', { body: {
    apiKey: `sk-ant-api03-${'ui-controlled-fixture-'.repeat(4)}Z9Q7`, payerOrganization: 'Lamp research group', providerWorkspace: 'Bedside prototype',
    workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true, providerBillingAcknowledged: true,
    projectDataDisclosureAcknowledged: true, maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 50, perRunCents: 5,
  } }), 201) as { id: string };
  // Controlled local compute only; the real worker cannot enable this rule.
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Camera readings at 5 lux', body: '38% of gestures detected; target is 90%.' } }), 201) as { materialId: string };
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/conversations`,
    { body: { clientMessageId: randomUUID(), body: 'Compare camera and ToF measurements under the same 5 lux conditions.' } }), 201) as { id: string; messages: { id: string }[] };
  const work = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/work`,
    { body: { title: 'Use the same controlled measurement protocol', outcome: 'Record distance, lighting and missed gestures for each sensor. '.repeat(50) } }), 201) as { id: string };
  const sketch = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/sketches`,
    { body: { title: 'Sensor ideas', scope: 'project', projectId: prj.id } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/sketches/${sketch.id}/thoughts`,
    { body: { text: 'Repeat the low-light gesture trial with a ToF sensor.', x: 0, y: 0 } }), 201);
  const masterKey = readFileSync('/run/secrets/flux_background_key');
  const provider: ComparisonProvider = {
    async countInputTokens() { return 100; },
    async createMessage(input) { return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 70 },
      answer: { kind: 'comparison', fact: 'The camera detected 38% of gestures at 5 lux.',
        interpretation: 'Low light may explain the missed target; there is no comparable ToF trial yet.',
        suggestedAction: 'Compare a ToF sensor under the same 5 lux conditions.',
        citations: input.sources.filter((source) => source.type === 'result' || source.type === 'message').map(({ type, id, version }) => ({ type, id, version })) } }; },
  };
  const candidate = async (title: string) => {
    const result = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/results`,
      { body: { title, finding: 'negative', evidence: '38% detected at 5 lux; target is 90%.',
        sources: [{ type: 'material', id: material.materialId, version: 1 }, { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as { id: string };
    const id = (await pool.query('SELECT id FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows[0].id as string;
    await comparisonDispatchFixtureDue(pool, id);
    return id;
  };
  const comparison = await dispatchProactiveComparison({ db, candidateId: await candidate('Camera trial missed the target'), masterKey, provider });
  if (comparison.status !== 'proposal') throw new Error(`Comparison fixture failed: ${comparison.status}`);
  const insufficient = await dispatchProactiveComparison({ db, candidateId: await candidate('No comparable ToF measurement'), masterKey,
    provider: { ...provider, async createMessage() { return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 70 },
      answer: { kind: 'insufficient_evidence', reason: 'The camera trial has no matching ToF measurement under the same lighting. ' +
        'Record a comparable sensor trial before choosing which approach to continue. '.repeat(7) } }; } } });
  if (insufficient.status !== 'insufficient_evidence') throw new Error(`Insufficient fixture failed: ${insufficient.status}`);
  const unknown = await dispatchProactiveComparison({ db, candidateId: await candidate('Interrupted comparison'), masterKey,
    provider: { ...provider, async createMessage() { throw new Error('Controlled local response loss'); } } });
  if (unknown.status !== 'unknown') throw new Error(`Unknown fixture failed: ${unknown.status}`);
  const notRun = await dispatchProactiveComparison({ db, candidateId: await candidate('Request without available key'), masterKey: null, provider });
  if (notRun.status !== 'not_run') throw new Error(`Not-run fixture failed: ${notRun.status}`);
  // A source leaves the project after inspection: omit its old title on current reads.
  await pool.query("UPDATE sketches SET scope='private',project_id=NULL WHERE id=$1", [sketch.id]);
  // Legacy dismissed fixtures force the two real quiet outcomes onto page 2. They do
  // not represent provider calls, and their old reservations are outside this period.
  const template = (await pool.query('SELECT * FROM proactive_comparison_proposals WHERE id=$1', [comparison.proposalId])).rows[0];
  for (let index = 0; index < 100; index++) {
    const candidateId = randomUUID(); const proposalId = randomUUID();
    const fingerprint = createHash('sha256').update(candidateId).digest('hex');
    await pool.query(`INSERT INTO proactive_comparison_outbox
      (id,rule_id,owner_user_id,project_id,result_id,source_fingerprint,status,connection_id,reserved_cents,reserved_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'completed',$7,5,now()-interval '31 days',now()-interval '31 days')`,
    [candidateId, rule.id, owner.id, prj.id, template.result_id, fingerprint, connection.id]);
    await pool.query(`INSERT INTO proactive_comparison_proposals
      (id,outbox_id,owner_user_id,agent_id,project_id,result_id,source_fingerprint,sources,fact,interpretation,suggested_action,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'[]','Earlier fixture fact','Earlier fixture interpretation','Earlier fixture suggestion','dismissed')`,
    [proposalId, candidateId, owner.id, agent.id, prj.id, template.result_id, fingerprint]);
    await pool.query('UPDATE proactive_comparison_outbox SET proposal_id=$1 WHERE id=$2', [proposalId, candidateId]);
  }
  writeFileSync('/state/proactive-outcomes-ui.json', JSON.stringify({ email: owner.email, viewerEmail: viewer.email, password,
    projectId: prj.id, workspaceId: ws.id, ownerId: owner.id, connectionId: connection.id, workId: work.id,
    proposalId: comparison.proposalId, insufficientId: insufficient.outcomeId, messageId: conversation.messages[0]!.id, conversationId: conversation.id }));
  process.stdout.write('Controlled outcome UI fixture ready; no real provider request\n');
} finally { await pool.end(); }
