import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { AiModelList } from '@flux/contracts';
import { RateLimitedError } from '@flux/core';
import { listProviderModels, parsePrivateTargets, MODEL_LIST_MAX_BYTES } from '../../packages/agent-runtime/src/index.js';
import { onePerPerson } from '../../apps/server/src/ai-keys/one-listing.js';

// A model list is read from a server a person names, so it is bounded (#1347, audit A): at most 1 MB, and one listing at a time for each
// person, the same one shared. The listings are read from a local server that answers whatever it is told to.

let server: Server;
let origin = '';
const body = (models: number) => JSON.stringify({ data: Array.from({ length: models }, (_, index) => ({ id: `model-${index}`, object: 'model' })) });
before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, origin);
    if (url.pathname === '/small/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(body(40)); return; }
    if (url.pathname === '/big/v1/models') {
      // Four megabytes of a valid list: past the bound it is never read to its end.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: Array.from({ length: 1_000 }, (_, index) => ({ id: `model-${index}`, note: 'x'.repeat(4_000) })) }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const local = () => parsePrivateTargets('127.0.0.1');

describe('model lists are bounded', () => {
  test('a list of a few dozen models is read; one that weighs more than a model list may is "unavailable", not read to its end', async () => {
    const small = await listProviderModels('openai_compatible', `${origin}/small/v1`, { policy: local() });
    assert.deepEqual([small.status, small.models.length], ['listed', 40]);
    const big = await listProviderModels('openai_compatible', `${origin}/big/v1`, { policy: local() });
    assert.deepEqual([big.status, big.models], ['unavailable', []], 'about 4 MB of answer');
    assert.ok(MODEL_LIST_MAX_BYTES <= 1_000_000, 'well below the 4 MB it was');
  });
});

describe('one listing at a time for each person', () => {
  test('the same listing asked again while it runs shares it; another one is refused until it ends; another person is not held', async () => {
    const run = onePerPerson<AiModelList>();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = (id: string) => async () => { started += 1; await gate; return { provider: 'openai_compatible', status: 'listed', models: [{ id, family: 'x', price: null }], checkedOn: '2026-11-13' } as unknown as AiModelList; };
    const first = run('ada', 'one', list('a'));
    const again = Array.from({ length: 40 }, () => run('ada', 'one', list('never-started')));
    assert.equal(started, 1, '41 asks of the same listing are one request to the server');
    await assert.rejects(run('ada', 'two', list('b')), (error) => error instanceof RateLimitedError && error.code === 'MODEL_LIST_BUSY' && error.status === 429);
    const other = run('bo', 'two', list('c'));
    assert.equal(started, 2, 'another person is not held by Ada\'s listing');
    release();
    const done = await Promise.all([first, ...again, other]);
    assert.equal(done[0]!.models[0]!.id, 'a');
    assert.ok(done.slice(1, 41).every((answer) => answer === done[0]), 'every sharing ask got the same answer');
    // After it ends, Ada may ask for another.
    assert.equal((await run('ada', 'two', list('d'))).models[0]!.id, 'd');
  });

  test('a listing that fails frees the person\'s place', async () => {
    const run = onePerPerson<string>();
    await assert.rejects(run('ada', 'one', async () => { throw new Error('refused'); }), /refused/);
    assert.equal(await run('ada', 'two', async () => 'listed'), 'listed');
  });
});
