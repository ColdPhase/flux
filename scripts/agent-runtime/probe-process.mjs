// Run as the CLI uid in the Docker slot. Probes report only access outcomes, never bytes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readdir, readFile } from 'node:fs/promises';

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
  console.log('CLI uid cannot read supervisor environment or write its memory');
} else {
  const native = process.argv[2];
  assert.ok(native?.endsWith('protect.node'));
  for (const protectedProcess of [false, true]) {
    // The attacker is the child's parent, so this control exercises the stricter case even
    // at ptrace_scope=1. In a slot the CLI is merely another process with the same uid.
    const code = `${protectedProcess ? 'require(process.argv[1]);' : ''} process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', code, native], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([chunk]) => String(chunk)),
        exited.then(([status]) => { throw new Error(`child exited ${status} before readiness`); }),
      ]);
      assert.equal(ready, 'ready\n');
      assert.deepEqual(await accessProcess(child.pid), { environ: !protectedProcess, memory: !protectedProcess });
      console.log(protectedProcess ? 'protected: environment and memory denied' : 'negative control: environment and memory accessible');
    } finally { child.kill('SIGKILL'); await exited; }
  }
}
