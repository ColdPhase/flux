import { readSync } from 'node:fs';

// The launcher of pi (#1441, RT-5): the program the slot starts for an API-key run. It reads ONE line from standard input before pi runs,
// `{"run":"<MCP run token>","model":"<model gateway token>"}`, puts the tokens into this process's environment (pi's own files name them,
// `${FLUX_RUN_TOKEN}` and `$FLUX_MODEL_GATEWAY_TOKEN`, so they are never written to a file), and then starts pi's own command-line program in this same process with the
// arguments it was given. The rest of standard input is the run's request, which pi reads as its prompt.
//
// Why a launcher: pi's own file tools run inside pi's process, which may read `/proc/self/environ`; that file holds only the environment
// a process was started with. A token set here, after the start, is not in it, so pi's tools cannot read it back (observed with pi 1.5.2,
// 2026-11-13). The commands pi runs start in Flux's sandbox shell, which starts every command with a clean environment.

const MAX_LINE = 16 * 1024;

function firstLine(): string {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let read: number;
    try { read = readSync(0, one, 0, 1, null); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue; throw error; }
    if (read === 0 || one[0] === 0x0a) break;
    bytes.push(one[0]!);
    if (bytes.length > MAX_LINE) throw new Error('The first line is too long');
  }
  return Buffer.from(bytes).toString('utf8');
}

const [cli, ...args] = process.argv.slice(2);
if (!cli || !cli.startsWith('/')) {
  console.error('usage: pi-launch <pi cli.js> <args>, with {"run":"<token>"} as the first line of standard input');
  process.exit(2);
}
const secrets = JSON.parse(firstLine()) as { run?: unknown; model?: unknown };
if (typeof secrets.run !== 'string' || !secrets.run || typeof secrets.model !== 'string' || !secrets.model) process.exit(2);
process.env.FLUX_RUN_TOKEN = secrets.run;
process.env.FLUX_MODEL_GATEWAY_TOKEN = secrets.model;
process.argv = [process.argv[0]!, cli, ...args];
await import(cli);
