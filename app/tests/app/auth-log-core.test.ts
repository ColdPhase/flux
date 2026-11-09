import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authLogEntry } from '../../apps/server/src/identity/auth-log.js';

// What Better Auth's own log lines may say (#1088, delta reviews of #1093 and #1098): enough to see why an authentication step failed (SSO
// above all), nothing personal or secret.

const printed = (entry: ReturnType<typeof authLogEntry>) => JSON.stringify(entry);

test('an OAuth refusal keeps its status, error code and masked description, and nothing else it holds', () => {
  const entry = authLogEntry('error', 'Failed to validate authorization code', [{
    status: 400, statusText: 'Bad Request', error: 'invalid_grant', error_description: 'Code not valid for ada@example.org',
    access_token: 'ACCESS-TOKEN', client_secret: 'CLIENT-SECRET', body: { code: 'AUTH-CODE', password: 'hunter2hunter2' },
  }]);
  assert.deepEqual(entry.object, { channel: 'auth', status: 400, statusText: 'Bad Request', oauthError: 'invalid_grant', oauthErrorDescription: 'Code not valid for <email>' });
  assert.equal(entry.text, 'Failed to validate authorization code');
  assert.equal(entry.level, 'error');
  for (const secret of ['ACCESS-TOKEN', 'CLIENT-SECRET', 'AUTH-CODE', 'hunter2', 'ada@example.org']) assert.ok(!printed(entry).includes(secret), secret);
});

test('betterFetch\'s failure, which nests the refusal one level down, is read the same way', () => {
  const entry = authLogEntry('error', 'Failed to validate authorization code', [{ data: null,
    error: { status: 401, statusText: 'Unauthorized', error: 'invalid_client', error_description: 'Invalid client credentials', request: { headers: { authorization: 'Basic SECRET' } } } }]);
  assert.deepEqual(entry.object, { channel: 'auth', status: 401, statusText: 'Unauthorized', oauthError: 'invalid_client', oauthErrorDescription: 'Invalid client credentials' });
  assert.ok(!printed(entry).includes('SECRET'));
});

test('an issuer mismatch and a provider id are kept; an error code that is not an OAuth code is not', () => {
  assert.deepEqual(authLogEntry('error', 'OAuth issuer mismatch', [{ expected: 'https://sso.example/realms/flux', received: 'https://evil.example' }]).object,
    { channel: 'auth', expected: 'https://sso.example/realms/flux', received: 'https://evil.example' });
  assert.deepEqual(authLogEntry('error', 'Unable to derive provider account identity', [{ providerId: 'company-sso', error: 'Some text with a "quote" and a name' }]).object,
    { channel: 'auth', providerId: 'company-sso' });
});

test('an error is its class, SQLSTATE and constraint; a database error\'s message, which holds the statement and its parameters, is not printed', () => {
  const failed = Object.assign(new Error('Failed query: insert into "auth_users" (...) values ($1, $2)\nparams: u1,ada@example.org,Ada Lovelace,1142029e:0a84'),
    { name: 'DrizzleQueryError', cause: { code: '23505', constraint: 'auth_users_email_unique' } });
  const entry = authLogEntry('error', 'Failed to create user', [failed]);
  assert.equal(entry.object.error, 'DrizzleQueryError · SQLSTATE 23505 · constraint auth_users_email_unique');
  assert.equal(entry.object.errorMessage, undefined);
  for (const leak of ['ada@example.org', 'Ada Lovelace', '1142029e', 'insert into']) assert.ok(!printed(entry).includes(leak), leak);
});

test('another error keeps its message with addresses masked, and a connection error keeps its code, also from its cause', () => {
  const plain = authLogEntry('warn', 'Failed to get user info', [new Error('Could not verify ada@example.org with the provider')]);
  assert.equal(plain.object.errorMessage, 'Could not verify <email> with the provider');
  const unreachable = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' }) });
  const entry = authLogEntry('error', 'Failed to validate authorization code', [unreachable]);
  assert.deepEqual(entry.object, { channel: 'auth', error: 'TypeError', code: 'ECONNREFUSED', errorMessage: 'fetch failed' });
  // A name that resolves to several addresses: undici wraps the failures in an AggregateError.
  const several = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(), { errors: [Object.assign(new Error('x'), { code: 'ENOTFOUND' })] }) });
  assert.equal(authLogEntry('error', 'x', [several]).object.code, 'ENOTFOUND');
  // The database refusing a connection: the code is kept, the statement is not.
  const database = Object.assign(new Error('Failed query: select * from "auth_sessions" where "user_id" = $1\nparams: user-1'), { name: 'DrizzleQueryError', cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const down = authLogEntry('error', 'Better auth was unable to query your database. Error:', [database]);
  assert.equal(down.object.code, 'ECONNREFUSED');
  assert.ok(!printed(down).includes('auth_sessions') && !printed(down).includes('user-1'));
});

test('an error passed as the message is one more thing the line was given, not its text', () => {
  const failed = Object.assign(new Error('Failed query: select "id" from "auth_sessions" where "user_id" = $1\nparams: ada@example.org'), { name: 'DrizzleQueryError', cause: { code: '08006' } });
  const entry = authLogEntry('error', failed, []);
  assert.equal(entry.text, 'Auth error');
  assert.equal(entry.object.error, 'DrizzleQueryError · SQLSTATE 08006');
  assert.ok(!printed(entry).includes('ada@example.org') && !printed(entry).includes('auth_sessions'));
});

test('strings, arrays and numbers it was given are not printed; the text is masked and cut; levels map to the logger\'s', () => {
  const entry = authLogEntry('info', `Sign-up attempt for existing email: ada@example.org ${'x'.repeat(400)}`, ['a string with a token', ['an array'], 42, null, undefined]);
  assert.deepEqual(entry.object, { channel: 'auth' });
  assert.ok(entry.text.startsWith('Sign-up attempt for existing email: <email> ') && entry.text.length === 240);
  assert.equal(entry.level, 'info');
  assert.equal(authLogEntry('success', 'x', []).level, 'info');
  assert.equal(authLogEntry('warn', 'x', []).level, 'warn');
  assert.equal(authLogEntry('debug', 'x', []).level, 'info');
});
