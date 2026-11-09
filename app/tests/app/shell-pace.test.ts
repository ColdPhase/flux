import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { SHELL_READS_PER_MINUTE, pacedShellRead, resetShellPace } from '../../apps/web/src/app/shellPace.js';

// #1126: a page that navigated in a loop read the person and the workspaces tens of thousands of times, and kept going when every read
// failed. The shell's reads are paced: unfinished reads back off, and no more than a set number start in any minute.
beforeEach(() => resetShellPace());

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const stopped = () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));

test('reads that finish go at once, however many in a row', async () => {
  for (let index = 0; index < 10; index += 1) assert.equal(await pacedShellRead(undefined, async () => index), index);
});

test('after three reads that did not finish, each waits twice as long as the last; one that finishes ends it', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (let index = 0; index < 3; index += 1) await assert.rejects(pacedShellRead(undefined, stopped));
  let started = false;
  const fourth = pacedShellRead(undefined, async () => { started = true; return 'read'; });
  await flush();
  assert.equal(started, false, 'the fourth waits');
  context.mock.timers.tick(249);
  await flush();
  assert.equal(started, false);
  context.mock.timers.tick(1);
  assert.equal(await fourth, 'read', 'a quarter of a second later it reads, and it finished');
  started = false;
  void pacedShellRead(undefined, async () => { started = true; return null; });
  await flush();
  assert.equal(started, true, 'after one that finished, the next goes at once');
});

test('the wait grows to at most 30 s, and a read stopped while it waits never starts', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (let index = 0; index < 3; index += 1) await assert.rejects(pacedShellRead(undefined, stopped));
  for (let wait = 250; wait <= 30_000; wait = Math.min(30_000, wait * 2)) {
    const read = pacedShellRead(undefined, stopped);
    context.mock.timers.tick(wait);
    await assert.rejects(read);
    if (wait === 30_000) break;
  }
  const abort = new AbortController();
  let started = false;
  const waiting = pacedShellRead(abort.signal, async () => { started = true; });
  context.mock.timers.tick(29_999);
  abort.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  context.mock.timers.tick(10);
  await flush();
  assert.equal(started, false, 'never started');
});

test(`never more than ${SHELL_READS_PER_MINUTE} reads start in a minute, even when every one finishes`, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (let index = 0; index < SHELL_READS_PER_MINUTE; index += 1) await pacedShellRead(undefined, async () => index);
  let started = false;
  const next = pacedShellRead(undefined, async () => { started = true; });
  context.mock.timers.tick(59_999);
  await flush();
  assert.equal(started, false, 'the next waits for the oldest to be a minute old');
  context.mock.timers.tick(1);
  await next;
  assert.equal(started, true);
});

test('a redirect (signed out) is an answer: it ends the back-off', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (let index = 0; index < 3; index += 1) await assert.rejects(pacedShellRead(undefined, stopped));
  const redirect = pacedShellRead(undefined, () => Promise.reject(new Response(null, { status: 302 })));
  context.mock.timers.tick(250);
  await assert.rejects(redirect, (error: unknown) => error instanceof Response);
  let started = false;
  void pacedShellRead(undefined, async () => { started = true; });
  await flush();
  assert.equal(started, true);
});
