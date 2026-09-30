/** Non-overlapping background recovery: starts immediately, retries on the next interval. */
export function startPersonalRunRecovery(options: {
  recover: () => Promise<number>;
  intervalMs?: number;
  log?: (error: unknown) => void;
}) {
  const { recover, intervalMs = 60_000, log = (error) => console.error('Personal-run recovery failed', error) } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const tick = async () => {
    try {
      const recovered = await recover();
      if (recovered) console.log(JSON.stringify({ job: 'personal-run.recover', recovered }));
    } catch (error) {
      log(error);
    } finally {
      if (!stopped) timer = setTimeout(() => { pending = tick(); }, intervalMs);
    }
  };
  pending = tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
