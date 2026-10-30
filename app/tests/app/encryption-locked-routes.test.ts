import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { CROSS_WORKSPACE_READ_ROUTES, LOCKED_ALLOWED_ROUTES, type Project } from '@flux/contracts';
import { pool } from './support/db.js';
import { createSealed, lock, passphrase } from './support/encryption.js';
import { addMember, expectStatus, person, type Person } from './support/people.js';

// AC-6 of F-030 (S2a-2c-4; docs/product/encrypted-workspaces.md#behaviour-while-locked): with no per-route gate, every
// registered route called with a locked encrypted workspace's objects answers 423, or is a metadata route listed in
// LOCKED_ALLOWED_ROUTES, or is a cross-workspace read that names the workspace in `lockedWorkspaces`. No answer is a
// 500, and none carries a canary or an envelope. The routes come from the server itself (test deployment only), with
// their body and query schemas, so a new route is walked (and must be classified) without editing this file.

interface Route { method: string; url: string; body: Schema | null; query: Schema | null }
interface Schema { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; const?: unknown; items?: Schema;
  minItems?: number; minProperties?: number; minLength?: number; maxLength?: number; minimum?: number; format?: string; pattern?: string; anyOf?: Schema[]; oneOf?: Schema[] }

/**
 * Parameters that name an object an encrypted workspace can never hold: AI work (F-029 forces it off before any write),
 * GitHub (refused), and the person's own account rows. A route reached only through them is not a route "for A's objects".
 */
const NOT_A_WORKSPACE_OBJECT: Readonly<Record<string, string>> = {
  connectionId: 'agent and background-compute connections (AI)', runId: 'assistant runs (AI)', proposalId: 'assistant and comparison proposals (AI)',
  changeId: 'assistant changes (AI)', jobId: 'assistant schedules (AI)', requestId: 'assistant join and coordination requests (AI)',
  agentId: 'agents (AI)', questionId: 'agent questions (AI)', outcomeId: 'comparison outcomes (AI)', ruleId: 'comparison rules (AI)',
  commandId: 'live Wiki receipts (refused until S2b)', bindingId: 'GitHub (refused)', installationId: 'GitHub (refused)',
  providerId: 'the person\'s sign-in links', ownerUserId: 'a person\'s assistant (AI)', owner: 'a person\'s assistant (AI)',
};
/** Generic `:id` parameters by route: an Inbox notification of A, or the person's own account rows. */
const ID_ROUTES: Readonly<Record<string, 'notification' | 'account' | 'decision'>> = {
  '/api/v1/inbox/:id': 'notification', '/api/v1/inbox/:id/read': 'notification', '/api/v1/inbox/:id/assistant-draft': 'notification',
  '/api/v1/push/subscriptions/:id': 'account', '/api/v1/sessions/:id': 'account', '/api/v1/projects/:projectId/work-objects/:kind/:id': 'decision',
  '/api/v1/workspaces/:workspace/people/:owner/assistant/when/:id': 'account',
};

/** Answers that refuse a feature an encrypted workspace does not offer, before any of its objects is read. */
const NOT_OFFERED: Readonly<Record<string, string>> = {
  '403 WORKSPACE_AI_BLOCKED': 'AI is always off in an encrypted workspace (F-029)',
  '409 WORKSPACE_ENCRYPTED_UNSUPPORTED': 'live Wiki and live maps until S2b',
  '503 GITHUB_UNAVAILABLE': 'GitHub is refused for an encrypted workspace, and not configured on the test server',
};
const codeOf = (text: string) => { try { return (JSON.parse(text) as { code?: string }).code ?? ''; } catch { return ''; } };

let ada: Person; let ben: Person;
let A: string; let empty: string;
const canary = `canary-routes-${randomUUID()}`;
const objects: Record<string, string> = {};
const key = () => ({ 'idempotency-key': randomUUID() });

async function post(who: Person, path: string, body: unknown, status: number, headers: Record<string, string> = {}) {
  return expectStatus(await who.browser.request('POST', path, { body, headers: { ...key(), ...headers } }), status, path) as Record<string, unknown>;
}

before(async () => {
  ada = await person('Ada');
  ben = await person('Ben');
  A = (await createSealed(ada, 'Locked club', passphrase())).workspace.id;
  await addMember(ada, A, ben, 'admin');
  const project = await post(ada, `/api/v1/workspaces/${A}/projects`, { name: `${canary} project`, visibility: 'workspace' }, 201) as unknown as Project;
  const conversation = await post(ada, `/api/v1/projects/${project.id}/conversations`, { body: `@Ben ${canary} message`, clientMessageId: randomUUID() }, 201);
  const dm = await post(ada, `/api/v1/workspaces/${A}/dms`, { participantIds: [ben.id], title: null }, 201);
  const dmMessage = await post(ada, `/api/v1/dms/${dm.id}/messages`, { body: `${canary} dm`, clientMessageId: randomUUID() }, 201);
  const decision = await post(ada, `/api/v1/projects/${project.id}/decisions`, { title: `${canary} decision`, rationale: 'why' }, 201);
  const result = await post(ada, `/api/v1/projects/${project.id}/results`, { title: `${canary} result`, finding: 'positive', evidence: 'seen' }, 201);
  const draft = await post(ada, `/api/v1/workspaces/${A}/drafts`, { title: `${canary} draft`, body: 'text' }, 201);
  const task = await post(ada, `/api/v1/projects/${project.id}/work`, { title: `${canary} task`, outcome: 'done', criteria: ['one'] }, 201);
  const doc = await post(ada, `/api/v1/projects/${project.id}/docs`, { title: `${canary} doc`, body: 'body' }, 201);
  const material = await post(ada, `/api/v1/projects/${project.id}/materials`, { clientMutationId: randomUUID(), title: `${canary} material`, body: 'b', url: 'https://example.test/m' }, 201);
  const sketch = await post(ada, `/api/v1/workspaces/${A}/sketches`, { title: `${canary} map`, scope: 'project', projectId: project.id }, 201);
  const one = await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: `${canary} thought`, x: 0, y: 0 }, 201);
  const two = await post(ada, `/api/v1/sketches/${sketch.id}/thoughts`, { text: 'two', x: 200, y: 0 }, 201);
  const link = await post(ada, `/api/v1/sketches/${sketch.id}/links`, { fromId: (one.thought as { id: string }).id, toId: (two.thought as { id: string }).id, label: 'label' }, 201);
  const upload = await fetch(new URL(`/api/v1/projects/${project.id}/files?uploadId=${randomUUID()}&name=${encodeURIComponent(`${canary}.txt`)}`, ada.browser.base), {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: ada.browser.cookieHeader(), origin: ada.browser.defaultOrigin }, body: Buffer.from(`bytes ${canary}`) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const file = await upload.json() as { id: string };
  let notification: string | undefined;
  for (let attempt = 0; attempt < 60 && !notification; attempt += 1) {
    notification = (await pool.query<{ id: string }>(`SELECT id FROM notifications WHERE user_id = $1 AND workspace_id = $2 LIMIT 1`, [ben.id, A])).rows[0]?.id;
    if (!notification) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(notification, 'Ben has a notification of A');
  Object.assign(objects, {
    workspaceId: A, workspace: A, projectId: project.id, conversationId: String(conversation.id), dmId: String(dm.id),
    rootId: String((dmMessage as { id?: string }).id ?? (dmMessage.message as { id: string }).id), messageId: String((conversation.messages as { id: string }[])[0]!.id),
    decisionId: String(decision.id), resultId: String(result.id), draftId: String(draft.id), workId: String(task.id), taskId: String(task.id),
    docId: String(doc.id), materialId: String(material.materialId ?? material.id), sketchId: String(sketch.id), thoughtId: String((one.thought as { id: string }).id),
    linkId: String((link.link as { id?: string } | undefined)?.id ?? link.id), fileId: file.id, userId: ben.id, version: '1', kind: 'decision',
    notification, grantId: randomUUID(), key: `note:${notification}`,
  });
  // A second encrypted space with nothing in it: its lists must answer 423 too, not an empty page.
  empty = (await createSealed(ada, 'Empty club', passphrase())).workspace.id;
  expectStatus(await lock(ada.browser, A), 200);
  expectStatus(await lock(ada.browser, empty), 200);
});

/** A minimal value that satisfies a JSON schema, with A's objects for every id-like property. */
function sample(schema: Schema | undefined, name = ''): unknown {
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.length) return sample(options.find((option) => option.type !== 'null') ?? options[0], name);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (objects[name] && (type === 'string' || type === undefined)) return objects[name];
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const property of schema.required ?? []) out[property] = sample(schema.properties?.[property], property);
      // A PATCH with no required field still needs one: the first optional property that is not a precondition.
      for (const property of Object.keys(schema.properties ?? {})) {
        if (Object.keys(out).length >= (schema.minProperties ?? 0)) break;
        if (!(property in out)) out[property] = sample(schema.properties![property], property);
      }
      for (const property of ['workspaceId', 'projectId']) if (schema.properties?.[property] && !(property in out)) out[property] = objects[property];
      return out;
    }
    case 'array': return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items, name));
    case 'integer': case 'number': return Math.max(schema.minimum ?? 1, 1);
    case 'boolean': return false;
    case 'string': {
      if (schema.format === 'uuid' || /Id$/.test(name)) return objects[name] ?? randomUUID();
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
      return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
    }
    default: return null;
  }
}

describe('F-030 AC-6: every route, called with a locked workspace\'s objects (S2a-2c-4)', () => {
  test('answers 423 or is a listed metadata route or a cross-workspace read; never 500, a canary or an envelope', async () => {
    const listing = await fetch(new URL('/api/v1/test/routes', ada.browser.base), { headers: { authorization: `Bearer ${process.env.FLUX_FIXTURE_TOKEN}` } });
    assert.equal(listing.status, 200);
    const routes = ((await listing.json()) as { routes: Route[] }).routes.filter((route) => route.url.startsWith('/api/v1/') && route.url !== '/api/v1/test/routes');
    assert.ok(routes.length > 250, `the server lists its routes (${routes.length})`);
    const unexpected: string[] = []; const walked: string[] = []; const notOfA: string[] = []; const refusedInput: string[] = []; let locked = 0;
    // Destructive routes run last, the deepest first, so they cannot take A's objects away from the others.
    const order = (route: Route) => (route.method === 'DELETE' ? 10 - route.url.split('/').length / 10 : LOCKED_ALLOWED_ROUTES[`${route.method} ${route.url}`] ? 1 : 0);
    for (const route of [...routes].sort((a, b) => order(a) - order(b))) {
      const routeKey = `${route.method} ${route.url}`;
      const params = [...route.url.matchAll(/:(\w+)/g)].map((match) => match[1]!);
      const generic = ID_ROUTES[route.url];
      const foreign = params.find((param) => NOT_A_WORKSPACE_OBJECT[param] || (param === 'id' && generic === 'account'));
      const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : sample(route.body ?? { type: 'object' });
      const namesA = params.some((param) => objects[param] || param === 'id') || (body !== null && typeof body === 'object' && ('workspaceId' in body || 'projectId' in body));
      if (foreign || !namesA) { notOfA.push(`${routeKey}${foreign ? ` (${foreign})` : ''}`); continue; }
      let path = route.url;
      for (const param of params) path = path.replace(`:${param}`, encodeURIComponent(param === 'id' ? objects[generic ?? 'notification']! : objects[param] ?? randomUUID()));
      const query = route.query ? sample(route.query) as Record<string, unknown> : {};
      for (const [name, value] of Object.entries(query ?? {})) if (value !== null && typeof value !== 'object') path += `${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(String(value))}`;
      // Ada created everything (her private drafts too); the Inbox and Needs you rows are Ben's.
      const who = /^\/api\/v1\/(inbox|needs-you)/.test(route.url) ? ben : ada;
      const response = await who.browser.request(route.method, path, { ...(body === undefined ? {} : { body }), headers: { ...key(), 'if-match': '"1"' } });
      walked.push(routeKey);
      if (response.status === 423) locked += 1;
      const text = response.text ?? '';
      if (response.status >= 500 && !NOT_OFFERED[`${response.status} ${codeOf(text)}`]) unexpected.push(`${routeKey} → ${response.status} ${text.slice(0, 120)}`);
      else if (text.includes(canary)) unexpected.push(`${routeKey} → a canary`);
      else if (/fx1\.[1-9][0-9]*\.[A-Za-z0-9_-]{20}/.test(text)) unexpected.push(`${routeKey} → an envelope`);
      else if (CROSS_WORKSPACE_READ_ROUTES.includes(routeKey)) {
        if (response.status === 200 && !text.includes(`"id":"${A}"`)) unexpected.push(`${routeKey} → 200 without lockedWorkspaces naming A`);
      } else if (response.status === 400) refusedInput.push(routeKey);
      else if (response.status !== 423 && !LOCKED_ALLOWED_ROUTES[routeKey] && !NOT_OFFERED[`${response.status} ${codeOf(text)}`]) unexpected.push(`${routeKey} → ${response.status} ${text.slice(0, 100)}`);
    }
    // The lists of an empty locked space: every GET whose only parameter is the workspace.
    for (const route of routes.filter((item) => item.method === 'GET' && /^\/api\/v1\/workspaces\/:(workspaceId|workspace)\/[^:]+$/.test(item.url))) {
      const routeKey = `${route.method} ${route.url}`;
      if (LOCKED_ALLOWED_ROUTES[routeKey] || CROSS_WORKSPACE_READ_ROUTES.includes(routeKey)) continue;
      const query = route.query ? sample(route.query) as Record<string, unknown> : {};
      let path = route.url.replace(/:(workspaceId|workspace)/, empty);
      for (const [name, value] of Object.entries(query ?? {})) if (value !== null && typeof value !== 'object' && name !== 'projectId') path += `${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(String(value))}`;
      const response = await ada.browser.request('GET', path);
      if (response.status !== 423 && response.status !== 400 && !NOT_OFFERED[`${response.status} ${codeOf(response.text ?? '')}`]) unexpected.push(`empty space: ${routeKey} → ${response.status} ${(response.text ?? '').slice(0, 80)}`);
    }
    assert.deepEqual(unexpected, [], `routes walked: ${walked.length}; not A's objects: ${notOfA.length}; input refused before any read: ${refusedInput.length}`);
    assert.ok(walked.length > 150, `the walk reached the workspace routes (${walked.length})`);
    assert.ok(locked * 2 > walked.length, `most routes answered 423 (${locked} of ${walked.length})`);
  });
});
