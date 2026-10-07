// Run as the CLI uid in the Docker slot. Probes report only access outcomes, never bytes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

async function inspectorAvailable() {
  try {
    const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(200) });
    return response.ok && (await response.json()).some((target) => target.webSocketDebuggerUrl);
  } catch { return false; }
}

async function signalInspector(pid, expected) {
  assert.equal(await inspectorAvailable(), false, 'no inspector before the signal');
  process.kill(pid, 'SIGUSR1');
  let available = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    await setTimeout(20);
    available = await inspectorAvailable();
    if (available) break;
  }
  assert.equal(Boolean(available), expected, 'SIGUSR1 inspector access');
}

async function accessProcess(pid) {
  const access = async (name, flags) => {
    try { const file = await open(`/proc/${pid}/${name}`, flags); await file.close(); return true; }
    catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code), `${name}: ${error.code}`); return false; }
  };
  return { environ: await access('environ', 'r'), memory: await access('mem', 'r+') };
}

if (process.argv[2] === 'supervisor') {
  // Compose uses an init process as PID 1; locate the actual Node supervisor by its argv.
  const matches = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const argv = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    if (argv.split('\0').some((name) => name.endsWith('/supervisor/main.js'))) matches.push(Number(entry));
  }
  assert.equal(matches.length, 1, 'exactly one running supervisor');
  assert.deepEqual(await accessProcess(matches[0]), { environ: false, memory: false });
  await signalInspector(matches[0], false);
  console.log('CLI uid cannot read supervisor environment, write its memory or open its inspector');
} else {
  const native = process.argv[2];
  assert.ok(native?.endsWith('protect.node'));
  for (const mode of ['unprotected', 'native-only', 'hardened']) {
    const protectedProcess = mode !== 'unprotected';
    // The attacker is the child's parent, so this control exercises the stricter case even
    // at ptrace_scope=1. In a slot the CLI is merely another process with the same uid.
    const code = `${protectedProcess ? 'require(process.argv[1]);' : ''} process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, [...(mode === 'hardened' ? ['--disable-sigusr1'] : []), '-e', code, native], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([chunk]) => String(chunk)),
        exited.then(([status]) => { throw new Error(`child exited ${status} before readiness`); }),
      ]);
      assert.equal(ready, 'ready\n');
      assert.deepEqual(await accessProcess(child.pid), { environ: !protectedProcess, memory: !protectedProcess });
      await signalInspector(child.pid, mode !== 'hardened');
      console.log(`${mode}: environment/memory ${protectedProcess ? 'denied' : 'accessible'}, signal inspector ${mode === 'hardened' ? 'denied' : 'accessible'}`);
    } finally { child.kill('SIGKILL'); await exited; }
  }
}
