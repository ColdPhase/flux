import { runAuthTable, type CliTarget } from './auth-table.js';

// Runs the sign-in/status/sign-out assertion table against the pinned REAL CLIs, in
// `docker run --network none`, no account (scripts/check_runtime_cli_contract.sh). The same table runs
// against the fakes in the normal checks. Usage: check-auth.js <claude path> <codex path>
const [claude, codex] = process.argv.slice(2);
if (!claude || !codex) { console.error('usage: check-auth.js <claude> <codex>'); process.exit(2); }
const targets: CliTarget[] = [
  { client: 'claude_code', path: claude, label: 'claude (real)' },
  { client: 'codex', path: codex, label: 'codex (real)', issuerArgs: (issuer) => ['--experimental_issuer', issuer] },
];
const results = await runAuthTable(targets);
for (const result of results) console.log(`${result.ok ? 'ok     ' : 'FAILED '} ${result.target}: ${result.name}${result.ok ? '' : `: ${result.detail}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), cases: results.length, failed }));
process.exit(failed ? 1 : 0);
