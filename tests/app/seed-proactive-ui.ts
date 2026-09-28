import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createDatabase } from '@flux/db';
import type { Conversation, Material, WorkResult } from '@flux/contracts';
import { expectStatus, password, person, project, workspace } from './support/people.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(process.env.DATABASE_URL);
try {
  const owner = await person('proactive-ui-owner');
  const ws = await workspace(owner, 'Sensor comparison studio');
  const prj = await project(owner, ws.id, 'Bedroom gesture controller', 'restricted');
  const agent = expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${ws.id}/agents`,
    { body: { name: 'Sensor comparison assistant', owner: 'self' } }), 201) as { id: string };
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/grants`,
    { body: { principal: { kind: 'agent', id: agent.id }, role: 'contributor' } }), 201);
  const rule = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/proactive-comparison-rules`,
    { body: { agentId: agent.id, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
      dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
      maxRunsPerDay: 3, periodBudgetCents: 15, perRunCents: 5 } }), 201) as { id: string };
  await pool.query("UPDATE proactive_comparison_rules SET status='enabled' WHERE id=$1", [rule.id]);
  const material = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/materials`,
    { body: { clientMutationId: randomUUID(), title: 'Low-light measurement, 5 lux',
      body: 'Camera A recognized 38% of 20 gestures. The target is 90%.' } }), 201) as Material;
  const conversation = expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/conversations`,
    { body: { clientMessageId: randomUUID(), body: 'Could a ToF distance sensor work better than our camera in a dark bedroom?' } }), 201) as Conversation;
  expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/work`,
    { body: { title: 'Measure ToF response at 5 lux' }, headers: { 'idempotency-key': randomUUID() } }), 201);
  const results: WorkResult[] = [];
  for (const title of ['Camera trial failed at 5 lux', 'Second low-light trial missed the target']) {
    results.push(expectStatus(await owner.browser.request('POST', `/api/v1/projects/${prj.id}/results`,
      { body: { title, finding: 'negative', evidence: 'Camera A recognized 38% of gestures at 5 lux; target was 90%.',
        sources: [{ type: 'material', id: material.materialId, version: 1 },
          { type: 'message', id: conversation.messages[0]!.id }] } }), 201) as WorkResult);
  }
  const proposalIds: string[] = [];
  for (const [index, result] of results.entries()) {
    const [candidate] = (await pool.query('SELECT id, source_fingerprint FROM proactive_comparison_outbox WHERE result_id=$1', [result.id])).rows;
    if (!candidate) throw new Error('UI fixture candidate missing');
    const id = randomUUID();
    const citations = [{ type: 'result', id: result.id, version: 1 },
      { type: 'material', id: material.materialId, version: 1 },
      { type: 'message', id: conversation.messages[0]!.id, version: 1, conversationId: conversation.id }];
    await pool.query(`INSERT INTO proactive_comparison_proposals
      (id, outbox_id, owner_user_id, agent_id, project_id, result_id, source_fingerprint,
        sources, fact, interpretation, suggested_action)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, candidate.id, owner.id, agent.id, prj.id, result.id, candidate.source_fingerprint,
      JSON.stringify(citations),
      index ? 'The second run still missed the 90% recognition target at 5 lux.' : 'Camera A recognized 38% of gestures at 5 lux.',
      'Low light may limit camera-based gesture recognition. This is an interpretation, not a decision.',
      'Compare a ToF distance sensor under the same 5 lux test.']);
    proposalIds.push(id);
  }
  writeFileSync('/state/proactive-ui.json', JSON.stringify({ email: owner.email, password,
    projectId: prj.id, proposalIds, conversationId: conversation.id, messageId: conversation.messages[0]!.id }));
  process.stdout.write('proactive-ui fixture ready\n');
} finally { await pool.end(); }
