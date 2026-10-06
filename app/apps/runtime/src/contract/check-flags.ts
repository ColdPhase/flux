import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RUNTIME_CLIENTS } from '@flux/runtime-protocol';
import { CLI_PATHS, TEMPLATE_FLAGS } from '../supervisor/templates.js';

// The flag contract check (F-022 Docker test plan, "Flag contract test"). OPT-IN and never in CI: it
// needs the pinned REAL CLIs (the release runtime image with Codex, and Claude Code installed by
// `runtime-install`), but no account. It runs each CLI's help and asserts that every flag and subcommand
// the fixed templates use is documented there. scripts/check_runtime_cli_contract.sh runs it.

const run = promisify(execFile);

async function help(path: string, args: readonly string[], home: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(path, [...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: `${home}/claude`, CODEX_HOME: `${home}/codex`, DISABLE_UPDATES: '1' } });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`;
  }
}

const documented = (textValue: string, flag: string) =>
  new RegExp(`(^|[\\s,\\[(])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,=\\])<]|$)`, 'm').test(textValue);

const home = await mkdtemp('/tmp/flux-contract-');
const report: Record<string, unknown> = { checkedAt: new Date().toISOString() };
let missing = 0;
try {
  for (const client of RUNTIME_CLIENTS) report[`${client}Version`] = (await help(CLI_PATHS[client], ['--version'], home)).trim().split('\n')[0];
  for (const { client, help: args, flags, optional = [] } of TEMPLATE_FLAGS) {
    const textValue = await help(CLI_PATHS[client], args, home);
    for (const flag of flags) {
      const ok = documented(textValue, flag);
      if (!ok) missing += 1;
      console.log(`${ok ? 'ok     ' : 'MISSING'} ${client} ${args.join(' ')}: ${flag}`);
    }
    for (const flag of optional) console.log(`${documented(textValue, flag) ? 'present' : 'absent '} ${client} ${args.join(' ')}: ${flag} (optional)`);
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, missing }));
process.exit(missing ? 1 : 0);
