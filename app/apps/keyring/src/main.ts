import { createKeyring } from './server.js';
import { swapFiles, swapSafe, testDeployment } from './swap.js';

// The keyring process (F-030, #655): refuses to start where its memory could be paged to disk, then listens on the
// internal `keyring` network only. Nothing it logs carries a key, a token or a body.
const env = process.env;
// TEST ONLY, and only in a test deployment: a directory holding fake `/proc/swaps` and cgroup files (Docker cannot mount
// over /proc), and the boot-key reveal of the log-scan check. Neither exists in a `./flux up` or release install.
const test = testDeployment(env);
if (!swapSafe(env, swapFiles(test ? env.FLUX_TEST_SWAP_ROOT ?? '' : ''))) {
  process.stderr.write('Flux keyring refuses to start: this server can write memory to disk. Turn off swap, limit this container\'s swap '
    + '(memswap_limit equal to mem_limit), or set FLUX_SWAP_ACKNOWLEDGED=encrypted-swap if every swap device is encrypted with a key not on disk.\n');
  process.exit(78);
}
const token = env.FLUX_KEYRING_TOKEN ?? '';
if (token.length < 32) {
  // A stack without a token (an older docker/.env, a check that needs no encryption) is valid: the keyring stays
  // idle and answers nothing, so every encrypted workspace is locked and creation answers 503 KEYRING_UNAVAILABLE.
  process.stderr.write('Flux keyring is idle: FLUX_KEYRING_TOKEN is not set (./flux and ./flux upgrade add it to docker/.env).\n');
  const idle = setInterval(() => undefined, 1 << 30);
  const stopIdle = () => { clearInterval(idle); process.exit(0); };
  process.once('SIGTERM', stopIdle);
  process.once('SIGINT', stopIdle);
} else {
  const revealBootKey = test && env.FLUX_KEYRING_REVEAL_BOOT_KEY === 'true';
  // Loud on purpose (S1 review): a keyring that can hand out its boot key protects nothing, so it must never pass unnoticed.
  if (revealBootKey) {
    process.stderr.write('WARNING: TEST ONLY. Flux keyring started with FLUX_KEYRING_REVEAL_BOOT_KEY=true: GET /v1/test/boot-key hands out the boot key. '
      + 'Encrypted spaces on this server are NOT protected. Never use this outside a test deployment.\n');
  }
  const keyring = createKeyring({ token, revealBootKey });
  keyring.server.listen(Number(env.FLUX_KEYRING_PORT ?? 8090), '0.0.0.0', () => process.stdout.write('Flux keyring ready\n'));
  const stop = () => { void keyring.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
