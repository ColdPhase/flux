import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolError } from '../../apps/server/src/agent-connection/tool-results.js';
import { databaseConflict } from '../../apps/server/src/http/errors.js';
import { pool } from './support/db.js';
import { expectStatus, person, project, workspace } from './support/people.js';

// A NUL character in a text field answered 500 on any route that stored it (#838, found by the ZAP active scan): PostgreSQL refuses
// 0x00 in text and in jsonb. It is the sender's input, so it is a 400 with the generic invalid-input code, and nothing is stored.

test('the database refusals of a NUL character map to a 400, whatever wrapped them', () => {
  for (const code of ['22021', '22P05']) {
    const mapped = databaseConflict(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('invalid byte sequence'), { code }) })) as { status?: number; code?: string };
    assert.deepEqual([mapped.status, mapped.code], [400, 'INVALID_INPUT'], code);
  }
  const other = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('deadlock'), { code: '40P01' }) });
  assert.equal(databaseConflict(other), other, 'any other database error is left alone');
});

test('an agent\'s tool call with a NUL character is told it is invalid input, not that the tool is broken', () => {
  const refused = toolError(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('invalid byte sequence'), { code: '22021' }) }));
  assert.equal(refused.isError, true);
  assert.deepEqual(JSON.parse(refused.content[0]!.text), { code: 'INVALID_INPUT', error: 'Text cannot contain a NUL character' });
  assert.deepEqual(JSON.parse(toolError(new Error('anything else')).content[0]!.text), { code: 'MCP_TOOL_UNAVAILABLE', error: 'Tool unavailable' });
});

test('a name with a NUL character is refused with 400 on the routes that store one, and nothing changes', async () => {
  const ada = await person('Nul Ada');
  const space = await workspace(ada, 'Nul club');
  const made = await project(ada, space.id, 'Before', 'restricted');
  const bad = '\u0000';
  const refused = [
    await ada.browser.request('PATCH', `/api/v1/projects/${made.id}`, { body: { name: bad } }),
    await ada.browser.request('PATCH', `/api/v1/workspaces/${space.id}`, { body: { name: bad } }),
    await ada.browser.request('POST', '/api/v1/workspaces', { body: { name: bad } }),
    await ada.browser.request('POST', `/api/v1/workspaces/${space.id}/projects`, { body: { name: `A${bad}B` } }),
    await ada.browser.request('POST', `/api/v1/workspaces/${space.id}/agents`, { body: { name: bad, owner: 'self' } }),
  ];
  for (const response of refused) {
    assert.equal(response.status, 400, response.text);
    assert.equal((response.json as { code?: string }).code, 'INVALID_INPUT');
  }
  const after = expectStatus(await ada.browser.request('GET', `/api/v1/projects/${made.id}`), 200) as { name: string };
  assert.equal(after.name, 'Before');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE name LIKE '%' || chr(1) || '%'")).rows[0].n, 0);
});

test('the sign-in routes refuse a NUL character with 400 instead of a bare 500, and a text that only spells it out is not one', async () => {
  const ada = await person('Nul Sign In');
  const bad = '\u0000';
  const refused = [
    await ada.browser.request('POST', '/api/auth/sign-in/email', { body: { email: `a${bad}b@example.com`, password: 'a long enough password' } }),
    await ada.browser.request('POST', '/api/auth/sign-up/email', { body: { email: 'nul@example.com', password: 'a long enough password', name: `N${bad}` } }),
    await ada.browser.request('POST', '/api/auth/request-password-reset', { body: { email: `a${bad}b@example.com` } }),
    await ada.browser.request('GET', '/api/auth/verify-email?token=a%00b'),
  ];
  for (const response of refused) {
    assert.equal(response.status, 400, response.text);
    assert.equal((response.json as { code?: string }).code, 'INVALID_INPUT');
  }
  const spelled = await ada.browser.request('POST', '/api/auth/sign-in/email', { body: { email: 'a\\u0000b@example.com', password: 'a long enough password' } });
  assert.notEqual((spelled.json as { code?: string } | null)?.code, 'INVALID_INPUT', 'six characters that spell the escape are ordinary text');
  assert.ok(spelled.status < 500, spelled.text);
});
