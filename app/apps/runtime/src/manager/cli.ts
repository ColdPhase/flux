import { callSupervisor, RUNTIME_SECRET } from '@flux/runtime-protocol';
import { listSlots, slotsFromEnv } from './server.js';

// Operator steps the launcher runs inside `runtime-manager` (`docker compose exec`), without the
// database: `slots` prints each slot's report; `sign-out-all` releases every binding directory found
// in any slot (sign out each CLI, delete the directory, confirm `/data` is empty, restart), which
// `./flux reset`, `./flux clean` and `./flux runtime purge` run first (F-022 "Backup, restore and
// cleanup"). Only outcome codes are printed, never CLI output.

const slots = slotsFromEnv(process.env, RUNTIME_SECRET);
const command = process.argv[2];
const config = { secret: '', slots };

if (command === 'slots') {
  for (const entry of await listSlots(config)) {
    if (!entry.reachable) { console.log(`${entry.slot}\tunreachable (${entry.error})`); continue; }
    const { report } = entry;
    console.log(`${entry.slot}\tboot ${report.bootId}\t${report.data.empty ? 'empty' : `bindings ${report.data.bindings.join(',') || '-'} other ${report.data.other}`}\tinstalled ${Object.entries(report.installed).filter(([, on]) => on).map(([client]) => client).join(',') || '-'}`);
  }
} else if (command === 'sign-out-all') {
  let failed = 0;
  for (const entry of await listSlots(config)) {
    if (!entry.reachable) { console.log(`${entry.slot}: unreachable (${entry.error}); its logins could not be signed out`); failed += 1; continue; }
    for (const bindingId of entry.report.data.bindings) {
      const outcome = await callSupervisor(slots.get(entry.slot)!, { kind: 'release', bindingId });
      if (outcome.ok && outcome.result.kind === 'release') {
        const { logout, dataEmpty } = outcome.result;
        console.log(`${entry.slot}: signed out (claude_code ${logout.claude_code}, codex ${logout.codex}); directory deleted; /data ${dataEmpty ? 'empty' : 'NOT empty'}`);
        if (!dataEmpty || Object.values(logout).some((step) => step === 'failed' || step === 'timeout')) failed += 1;
      } else {
        console.log(`${entry.slot}: release failed (${outcome.ok ? 'protocol' : outcome.code})`);
        failed += 1;
      }
    }
    if (entry.report.data.other > 0) { console.log(`${entry.slot}: /data holds ${entry.report.data.other} other entr${entry.report.data.other === 1 ? 'y' : 'ies'}`); failed += 1; }
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: node apps/runtime/dist/manager/cli.js slots|sign-out-all');
  process.exit(2);
}
