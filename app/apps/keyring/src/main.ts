import { createKeyring } from './server.js';
import { swapFiles, swapSafe } from './swap.js';

// The keyring process (F-030, #655): refuses to start where its memory could be paged to disk, then listens on the
// internal `keyring` network only. Nothing it logs carries a key, a token or a body.
const env = process.env;
// TEST ONLY: a directory holding fake `/proc/swaps` and cgroup files (Docker cannot mount over /proc). It gives no more
// power than FLUX_SWAP_ACKNOWLEDGED, which an operator can set anyway.
if (!swapSafe(env, swapFiles(env.FLUX_TEST_SWAP_ROOT ?? ''))) {
  process.stderr.write('Flux keyring refuses to start: this server can write memory to disk. Turn off swap, limit this container\'s swap '
    + '(memswap_limit equal to mem_limit), or set FLUX_SWAP_ACKNOWLEDGED=encrypted-swap if every swap device is encrypted with a key not on disk.\n');
  process.exit(78);
}
const token = env.FLUX_KEYRING_TOKEN ?? '';
if (token.length < 32) {
  process.stderr.write('Flux keyring refuses to start: FLUX_KEYRING_TOKEN must be set (./flux adds it to docker/.env).\n');
  process.exit(78);
}
const keyring = createKeyring({ token });
keyring.server.listen(Number(env.FLUX_KEYRING_PORT ?? 8090), '0.0.0.0', () => process.stdout.write('Flux keyring ready\n'));
const stop = () => { void keyring.close().then(() => process.exit(0)); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
