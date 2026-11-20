import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { NotFoundError } from '@flux/core';
import { createMcpDispatch } from '../../apps/server/src/agent-connection/mcp-dispatch.js';
import { agentToolRegistry, ASSISTANT_UNIT_CREATE_INPUT } from '../../apps/server/src/agent-connection/tool-registry.js';
import { configureToolLog, recordToolCall, toolError, toolResult } from '../../apps/server/src/agent-connection/tool-results.js';
import { db } from './support/db.js';

// #1555: an error inside an agent tool was told to the model as "Tool unavailable" and logged nowhere. Every tool call is now one line of the
// API's log (tool, run or connection, outcome, duration; never arguments or content), and an error inside Flux one error line more, with the
// error id the model is told, its class and its stack frames. The run path of a real map change is in assistant-changes.test.ts.

type Line = { level: 'info' | 'error'; fields: Record<string, unknown>; message: string };
let lines: Line[] = [];
const capture = () => {
  lines = [];
  configureToolLog({ info: (fields, message) => lines.push({ level: 'info', fields, message }), error: (fields, message) => lines.push({ level: 'error', fields, message }) });
};
afterEach(() => configureToolLog({ info: () => undefined, error: () => undefined }));

/** One read tool on a local client's definitions, called the way the SDK calls it, with the handler the test gives. */
function callTool(handler: () => unknown) {
  const manifest = { declare() { /* the full list is not registered here */ }, verifyRegistrations() { /* idem */ } };
  const tools = agentToolRegistry(manifest, db, false);
  tools.forAccess('read').registerTool('flux_read_file', { title: 'Read the text of a file', description: 'Read a file.',
    // Any zod schema of the server's own: nothing validates the input here.
    inputSchema: ASSISTANT_UNIT_CREATE_INPUT }, handler as never);
  let callback: ((input: unknown) => Promise<unknown>) | null = null;
  tools.bind({ registerTool: (_name: string, _config: unknown, cb: (input: unknown) => Promise<unknown>) => { callback = cb; } } as never,
    { ownerUserId: randomUUID(), connectionId: randomUUID(), clientId: null, grantReferenceId: null, dispatch: createMcpDispatch() });
  return callback!({ fileId: randomUUID() }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

test('a tool that throws an unexpected error: one error line with the tool, no content, and a failure with that error id', async () => {
  capture();
  const secret = 'Marketing OH: the launch budget is 40k';
  const result = await callTool(() => { throw Object.assign(new Error(`insert failed for "${secret}"`), { code: '23514', constraint: 'sketch_thoughts_text_check' }); });
  assert.equal(result.isError, true);
  const told = JSON.parse(result.content[0]!.text) as { code: string; error: string };
  assert.equal(told.code, 'TOOL_FAILED');
  const id = /error id ([0-9a-f-]{36})/.exec(told.error)?.[1];
  assert.ok(id, told.error);
  const errors = lines.filter((line) => line.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.fields.tool, 'flux_read_file');
  assert.equal(errors[0]!.fields.errorId, id);
  assert.equal(errors[0]!.fields.error, 'Error · SQLSTATE 23514 · constraint sketch_thoughts_text_check');
  assert.match(String(errors[0]!.fields.stack), /^at /);
  const info = lines.filter((line) => line.level === 'info');
  assert.equal(info.length, 1);
  assert.deepEqual({ ...info[0]!.fields, ms: 0, connectionId: null }, { event: 'tool', tool: 'flux_read_file', operation: null, runId: null, connectionId: null,
    outcome: 'error', code: 'TOOL_FAILED', errorId: id, ms: 0 });
  assert.ok(!JSON.stringify(lines).includes('launch budget') && !JSON.stringify(lines).includes('Marketing'), 'no content in the log');
});

test('a tool that returns its own unexpected error through toolError is logged the same way; a refusal and a success log one line each', async () => {
  capture();
  const failed = await callTool(() => toolError(new TypeError('Cannot read properties of undefined (reading "thought")')));
  assert.equal(JSON.parse(failed.content[0]!.text).code, 'TOOL_FAILED');
  assert.deepEqual(lines.map((line) => line.level), ['error', 'info']);
  assert.equal(lines[0]!.fields.error, 'TypeError');

  capture();
  await callTool(() => toolError(new NotFoundError('File', 'FILE_NOT_FOUND')));
  await callTool(() => ({ content: [{ type: 'text', text: 'Not attached. That address is private.' }], isError: true }));
  await callTool(() => toolResult({ ok: true }));
  assert.deepEqual(lines.map((line) => [line.level, line.fields.outcome, line.fields.code ?? null]),
    [['info', 'error', 'FILE_NOT_FOUND'], ['info', 'error', 'REFUSED'], ['info', 'ok', null]]);
});

test('a run\'s line names its run and the change operation', () => {
  capture();
  const runId = randomUUID();
  recordToolCall({ tool: 'flux_add_thought', operation: 'map.thought.create', runId, connectionId: randomUUID(), ms: 12.4 }, toolError(new Error('x')));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(line.fields.runId, runId);
  assert.equal(lines[1]!.fields.ms, 12);
  assert.equal(lines[1]!.fields.operation, 'map.thought.create');
});
