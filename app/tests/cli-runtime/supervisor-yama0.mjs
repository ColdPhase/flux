// TEST ONLY (#1125, scripts/check_cli_runtime.sh): the runtime's own supervisor (apps/runtime/dist/supervisor/main.js, unchanged) on
// a host whose kernel.yama.ptrace_scope is 0. That is the one host requirement (RT-3) the check cannot meet without changing the host,
// so only that file reads as 1 to the supervisor; its other start-up checks (Node flags, root, capabilities, its secret, /data) and
// everything after them run as in production. The check uses this entry only when it finds scope 0, and says so.
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const YAMA = '/proc/sys/kernel/yama/ptrace_scope';
const readFile = fsp.readFile;
fsp.readFile = (path, ...rest) => (path === YAMA ? Promise.resolve('1\n') : readFile(path, ...rest));
syncBuiltinESMExports();
await import('/opt/flux-runtime/apps/runtime/dist/supervisor/main.js');
