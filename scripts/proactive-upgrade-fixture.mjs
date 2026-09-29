/* global process, fetch, crypto, console */
// Runs inside the API image for the same-volume #58 migration rehearsal. No provider calls.
const api = 'http://127.0.0.1:8080';
const origin = process.env.FLUX_PUBLIC_ORIGIN;
const phase = process.env.FLUX_UPGRADE_PHASE;
const state = phase === 'verify' ? JSON.parse(process.env.FLUX_UPGRADE_STATE) : {};
let cookie = state.cookie ?? '';
async function request(method, path, body, expected = 200) {
  const response = await fetch(`${api}${path}`, { method, headers: {
    origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const text = await response.text();
  if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const same = (actual, expected, context) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${context} changed across upgrade`);
};

if (phase === 'prepare') {
  await request('POST', '/api/auth/sign-in/email', { email: 'ada@demo.flux.test', password: process.env.FLUX_DEMO_OWNER_PASSWORD });
  const me = await request('GET', '/api/v1/me');
  const ws = (await request('GET', '/api/v1/workspaces')).find((item) => item.name === 'Riverside Makers (demo)');
  if (!ws) throw new Error('Demo workspace missing');
  const project = await request('POST', `/api/v1/workspaces/${ws.id}/projects`, { name: 'Comparison upgrade', visibility: 'restricted' }, 201);
  const agent = await request('POST', `/api/v1/workspaces/${ws.id}/agents`, { name: 'Upgrade comparison agent', owner: 'self' }, 201);
  await request('POST', `/api/v1/projects/${project.id}/grants`, { principal: { kind: 'agent', id: agent.id }, role: 'contributor' }, 201);
  const material = await request('POST', `/api/v1/projects/${project.id}/materials`, { clientMutationId: crypto.randomUUID(),
    title: 'Low-light measurement', body: 'Initial measurement.' }, 201);
  await request('PATCH', `/api/v1/materials/${material.materialId}`, { clientMutationId: crypto.randomUUID(), expectedVersion: 1,
    body: 'Camera A detected 38% of gestures at 5 lux.' });
  const conversation = await request('POST', `/api/v1/projects/${project.id}/conversations`, { clientMessageId: crypto.randomUUID(),
    body: 'Repeat the controlled low-light comparison.', source: { materialId: material.materialId, version: 1 } }, 201);
  const draft = await request('POST', `/api/v1/workspaces/${ws.id}/drafts`, { title: 'Private upgrade note', body: 'Keep this draft private.' }, 201);
  const result = await request('POST', `/api/v1/projects/${project.id}/results`, { title: 'Camera trial failed', finding: 'negative',
    evidence: 'Detection was below the target.', sources: [{ type: 'material', id: material.materialId, version: 2 },
      { type: 'message', id: conversation.messages[0].id }] }, 201);
  console.log(`FLUX_UPGRADE_STATE ${JSON.stringify({ cookie, userId: me.user.id, workspaceId: ws.id, projectId: project.id,
    agentId: agent.id, materialId: material.materialId, conversationId: conversation.id, draftId: draft.id, resultId: result.id })}`);
} else if (phase === 'verify') {
  same((await request('GET', '/api/v1/me')).user.id, state.userId, 'Original browser session');
  const material = await request('GET', `/api/v1/materials/${state.materialId}`);
  same(material.version, 2, 'Material version');
  same(material.body, 'Camera A detected 38% of gestures at 5 lux.', 'Material text');
  const conversation = await request('GET', `/api/v1/conversations/${state.conversationId}`);
  same(conversation.messages[0].source, { materialId: state.materialId, version: 1 }, 'Historical citation');
  same((await request('GET', `/api/v1/drafts/${state.draftId}`)).body, 'Keep this draft private.', 'Private draft');
  const rule = await request('POST', `/api/v1/projects/${state.projectId}/proactive-comparison-rules`, {
    agentId: state.agentId, trigger: 'human_negative_result', purpose: 'camera_sensor_comparison',
    dataScope: 'current_project_published', permittedEffect: 'quiet_project_proposal',
    maxRunsPerDay: 3, periodBudgetCents: 15, perRunCents: 5 }, 201);
  same(rule.status, 'paused', 'New rule default');
  await request('POST', '/api/v1/background-compute-connections', { apiKey: `sk-ant-api03-${'upgrade-local-fixture-'.repeat(4)}END8`,
    payerOrganization: 'Local migration fixture', providerWorkspace: 'Local migration fixture', workspaceScopedKeyConfirmed: true,
    payerAuthorityConfirmed: true, providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
    maxRunsPerDay: 3, periodDays: 30, periodBudgetCents: 15, perRunCents: 5 }, 201);
  const blocked = await request('PATCH', `/api/v1/proactive-comparison-rules/${rule.id}`, { expectedVersion: rule.version, status: 'enabled' }, 409);
  same(blocked.code, 'BACKGROUND_RUNTIME_UNAVAILABLE', 'Production activation gate');
  const rules = await request('GET', `/api/v1/projects/${state.projectId}/proactive-comparison-rules`);
  same(rules[0].status, 'paused', 'Activation failure preserves paused rule');
  same(await request('GET', `/api/v1/projects/${state.projectId}/proactive-comparison-proposals`), [], 'No retroactive proposal');
  await request('POST', `/api/v1/projects/${state.projectId}/work`, { title: 'Compare the next sensor manually' }, 201);
  console.log('Verified original session, material revisions, historical citation, private draft, new rule/key storage and manual continuation; no provider invoked.');
} else throw new Error('FLUX_UPGRADE_PHASE must be prepare or verify');
