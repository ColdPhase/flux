import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { capacityFromMemory, MAX_RUNS, runCapacity } from '../../apps/runtime/src/supervisor/capacity.js';
import { hostProblem, SUPERVISOR_CAPABILITIES } from '../../apps/runtime/src/supervisor/requirements.js';

// #860: how many agents run at once, from memory and the operator's number; and what a host must offer, with one clear message
// when it does not. The queue itself is in agent-runtime-runs.test.ts; separate user ids in scripts/check_runtime_people.sh.

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('how many agents run at once', () => {
  test('it follows the runtime\'s memory: about 2 on a 4 GB server, never 0', () => {
    // ./flux gives the runtime the server's memory less 1.5 GiB.
    assert.equal(capacityFromMemory(3.8 * GIB - 1.25 * GIB), 2, '4 GB');
    assert.equal(capacityFromMemory(3.6 * GIB - 1.25 * GIB), 2, 'a 4 GB machine that reports less');
    assert.equal(capacityFromMemory(2560 * MIB), 2, 'the Compose default');
    assert.equal(capacityFromMemory(7.7 * GIB - 1.25 * GIB), 6, '8 GB');
    assert.equal(capacityFromMemory(15.6 * GIB - 1.25 * GIB), 14, '16 GB');
    assert.equal(capacityFromMemory(900 * MIB), 1, 'a small server still runs one');
    assert.equal(capacityFromMemory(0), 1);
    assert.equal(capacityFromMemory(2 ** 53), MAX_RUNS);
  });

  test('the operator\'s number wins; a wrong one is refused, never guessed', () => {
    assert.equal(runCapacity('7', 2560 * MIB), 7);
    assert.equal(runCapacity(' 1 ', 64 * GIB), 1);
    assert.equal(runCapacity('', 2560 * MIB), 2);
    assert.equal(runCapacity(undefined, 2560 * MIB), 2);
    for (const wrong of ['0', '-1', '2.5', 'two', '10000']) assert.throws(() => runCapacity(wrong, GIB), /FLUX_RUNTIME_MAX_RUNS/, wrong);
  });
});

describe('what the host must offer', () => {
  const met = { ptraceScope: '1\n', uid: 0, effectiveCapabilities: '00000000000000eb' };

  test('a host that meets everything has no problem', () => {
    assert.equal(hostProblem(met), null);
    for (const scope of ['2', '3']) assert.equal(hostProblem({ ...met, ptraceScope: scope }), null);
    assert.equal(hostProblem({ ...met, effectiveCapabilities: 'ffffffffff' }), null);
  });

  test('ptrace_scope=0 stops the runtime with one message and the fix', () => {
    const message = hostProblem({ ...met, ptraceScope: '0\n' })!;
    assert.match(message, /kernel\.yama\.ptrace_scope of 1 or higher/);
    assert.match(message, /sudo sysctl -w kernel\.yama\.ptrace_scope=1/);
    assert.match(message, /\/etc\/sysctl\.d\//, 'and it survives a reboot');
    assert.doesNotMatch(message, /\n/, 'one line');
  });

  test('a kernel without Yama (Docker Desktop) is refused like scope 0: absence never bypasses the gate', () => {
    assert.match(hostProblem({ ...met, ptraceScope: '' })!, /this kernel has none: run Flux on a Linux host whose kernel has Yama\./);
  });

  test('without root in the container, or without each capability, people cannot be kept apart: refused', () => {
    assert.match(hostProblem({ ...met, uid: 1000 })!, /start as root inside its container/);
    assert.match(hostProblem({ ...met, effectiveCapabilities: '0' })!, new RegExp(SUPERVISOR_CAPABILITIES.join(', ')));
    assert.match(hostProblem({ ...met, effectiveCapabilities: 'garbage' })!, /capabilities/);
    assert.match(hostProblem({ ...met, effectiveCapabilities: '00000000000000ea' })!, /capabilities CHOWN inside/);
    assert.match(hostProblem({ ...met, effectiveCapabilities: '000000000000006b' })!, /capabilities SETUID inside/);
  });

  test('the supervisor refuses in one line, stays up without listening and does not exit into a restart loop', async () => {
    // The test container has no root and no capabilities, whatever the host's ptrace_scope.
    const child = spawn(process.execPath, ['--disable-sigusr1', resolve('apps/runtime/dist/supervisor/main.js')], {
      env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    child.once('exit', () => { exited = true; });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    await new Promise((done) => setTimeout(done, 1_500));
    assert.equal(exited, false, 'it does not exit: a restart policy would start it again forever');
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 1, output);
    const line = JSON.parse(lines[0]!) as { event: string; message: string };
    assert.equal(line.event, 'runtime_refused');
    assert.ok(line.message.length > 20);
    assert.doesNotMatch(output, /"event":"ready"/);
    const ended = new Promise<number | null>((done) => child.once('exit', done));
    child.kill('SIGTERM');
    assert.equal(await ended, 0, 'it stops when asked');
  });
});
