import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { allowedAppServerMethod, openAppServer } from '../supervisor/app-server.js';
import { effectiveConfigHolds, RUN_BRIEF } from '../supervisor/run.js';
import { CLI_PATHS, CODEX_FEATURE_REVIEW, codexRunOverrides } from '../supervisor/templates.js';

// The Codex part of the contract check (F-022 T6 #281). OPT-IN and never in CI: it needs the pinned REAL
// `codex` (no account, no network: run it in `docker run --network none`). It checks:
// 1. `codex features list`: every feature the pinned version enables by default is named in
//    CODEX_FEATURE_REVIEW (switched off, or kept with a reason). An unknown default-on feature fails.
// 2. `codex <run overrides> features list`: every feature the review switches off is off.
// 3. `codex app-server` with the run's overrides: `config/read` reflects them (the blocking preflight's
//    premise), so effectiveConfigHolds accepts it; and without them it does not.
// 4. The app-server client refuses `command/exec` before writing anything.
// Usage: node check-codex.js [path-to-codex]. Prints one JSON summary; exit 1 on any failure.

const run = promisify(execFile);
const codex = process.argv[2] ?? CLI_PATHS.codex;
const home = await mkdtemp('/tmp/flux-codex-contract-');
await mkdir(`${home}/codex`, { mode: 0o700 });
await mkdir(`${home}/home`, { mode: 0o700 });
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: `${home}/home`, CODEX_HOME: `${home}/codex`, LANG: 'C.UTF-8' };
const failures: string[] = [];
const report: Record<string, unknown> = { checkedAt: new Date().toISOString() };

/** `name  stage  true|false` lines of `codex features list`. */
async function features(args: readonly string[]): Promise<Map<string, boolean>> {
  const { stdout } = await run(codex, [...args, 'features', 'list'], { env, cwd: home, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const found = new Map<string, boolean>();
  for (const line of stdout.split('\n')) {
    const match = /^([a-z0-9_]+)\s+.*\s(true|false)\s*$/.exec(line.trim());
    if (match) found.set(match[1]!, match[2] === 'true');
  }
  return found;
}

const tools = ['flux_list_contexts', 'flux_read_source'];
const mcpUrl = 'http://runtime-egress:8080/mcp';
const overrides = codexRunOverrides(tools, mcpUrl, RUN_BRIEF);
try {
  report.version = (await run(codex, ['--version'], { env, cwd: home, timeout: 30_000 })).stdout.trim();
  const defaults = await features([]);
  if (!defaults.size) failures.push('features list printed no feature');
  const defaultOn = [...defaults].filter(([, on]) => on).map(([key]) => key).sort();
  report.defaultOn = defaultOn;
  const unknown = defaultOn.filter((key) => !Object.hasOwn(CODEX_FEATURE_REVIEW, key));
  for (const key of unknown) failures.push(`default-on feature not reviewed: ${key}`);
  const applied = await features(overrides);
  const stillOn = Object.entries(CODEX_FEATURE_REVIEW).filter(([key, review]) => review.action === 'off' && applied.get(key) !== false).map(([key]) => key);
  for (const key of stillOn) failures.push(`override did not switch off: ${key}`);
  report.offApplied = Object.keys(CODEX_FEATURE_REVIEW).length - stillOn.length;

  const withOverrides = await openAppServer(codex, home, '127.0.0.1', { timeoutMs: 30_000, overrides });
  const read = await withOverrides.request('config/read', {}) as { config?: unknown };
  withOverrides.close();
  report.configReadReflectsOverrides = effectiveConfigHolds(read?.config, tools, mcpUrl);
  if (!report.configReadReflectsOverrides) failures.push('config/read does not reflect the -c overrides');
  const plain = await openAppServer(codex, home, '127.0.0.1', { timeoutMs: 30_000 });
  const bare = await plain.request('config/read', {}) as { config?: unknown };
  report.refusedCommandExec = await plain.request('command/exec', { command: ['true'] }).then(() => false, (error: Error) => error.name === 'AppServerMethodRefused');
  plain.close();
  if (effectiveConfigHolds(bare?.config, tools, mcpUrl)) failures.push('config/read without overrides passed the preflight');
  if (!report.refusedCommandExec || allowedAppServerMethod('command/exec')) failures.push('command/exec was not refused');
} catch (error) {
  failures.push(`check failed: ${(error as Error).message.slice(0, 200)}`);
} finally {
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, failures }, null, 1));
process.exit(failures.length ? 1 : 0);
