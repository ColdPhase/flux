import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RUNTIME_CLIENTS } from '@flux/runtime-protocol';
import { CLAUDE_LOGIN_HELP_OPTIONS, CLI_PATHS, helpOptions, TEMPLATE_FLAGS } from '../supervisor/templates.js';

// The flag contract check (F-022 Docker test plan, "Flag contract test"). OPT-IN and never in CI: it
// needs the pinned REAL CLIs (the release runtime image with Codex, and Claude Code installed by
// `runtime-install`), but no account. It runs each CLI's help and asserts that every flag and subcommand
// the fixed templates use is documented there. scripts/check_runtime_cli_contract.sh runs it.

const run = promisify(execFile);

async function invoke(path: string, args: readonly string[], home: string): Promise<{ code: number; text: string }> {
  try {
    const { stdout, stderr } = await run(path, [...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: `${home}/claude`, CODEX_HOME: `${home}/codex`, DISABLE_UPDATES: '1' } });
    return { code: 0, text: `${stdout}\n${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : 1, text: `${failed.stdout ?? ''}\n${failed.stderr ?? ''}` };
  }
}
const help = async (path: string, args: readonly string[], home: string) => (await invoke(path, args, home)).text;

/**
 * A flag the help does not list may still be a hidden option. It counts as accepted only when the CLI
 * treats it differently from a made-up flag (the control): either `<flag> 1 --version` prints the
 * version while the made-up flag does not, or a one-shot print run (no network here, so it fails
 * later) does not report the flag as unknown while it reports the made-up one.
 */
async function acceptedHidden(path: string, flag: string, home: string, version: string): Promise<boolean> {
  const unknown = /unknown option|unexpected argument|unrecognized/i;
  const control = await invoke(path, ['--flux-no-such-flag', '1', '--version'], home);
  const candidate = await invoke(path, [flag, '1', '--version'], home);
  if (!(control.code === 0 && control.text.includes(version)) && candidate.code === 0 && candidate.text.includes(version)) return true;
  const controlRun = await invoke(path, ['-p', 'x', '--flux-no-such-flag', '1'], home);
  const candidateRun = await invoke(path, ['-p', 'x', flag, '1'], home);
  return unknown.test(controlRun.text) && !unknown.test(candidateRun.text);
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
      if (documented(textValue, flag)) { console.log(`ok      ${client} ${args.join(' ')}: ${flag}`); continue; }
      const version = String(report[`${client}Version`] ?? '').split(' ')[0] ?? '';
      const hidden = flag.startsWith('--') && version !== '' && await acceptedHidden(CLI_PATHS[client], flag, home, version);
      if (!hidden) missing += 1;
      console.log(`${hidden ? 'hidden ' : 'MISSING'} ${client} ${args.join(' ')}: ${flag}${hidden ? ' (not in the help, but accepted; a made-up flag is refused)' : ''}`);
    }
    for (const flag of optional) console.log(`${documented(textValue, flag) ? 'present' : 'absent '} ${client} ${args.join(' ')}: ${flag} (optional)`);
  }
  // T4: the console offers every method of `claude auth login`. Any option the help lists that is not
  // a known method or a known non-method fails the check.
  const loginHelp = await help(CLI_PATHS.claude_code, ['auth', 'login', '--help'], home);
  const listed = helpOptions(loginHelp);
  if (!listed.length) { missing += 1; console.log('MISSING claude_code auth login --help: no options listed'); }
  for (const option of listed) {
    const known = Object.hasOwn(CLAUDE_LOGIN_HELP_OPTIONS, option) ? CLAUDE_LOGIN_HELP_OPTIONS[option] : undefined;
    if (!known) missing += 1;
    console.log(`${known ? 'ok     ' : 'UNKNOWN'} claude_code auth login --help lists ${option}: ${known ? known.note : 'a sign-in option the console does not offer'}`);
  }
  report.claudeLoginOptions = listed;
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, missing }));
process.exit(missing ? 1 : 0);
