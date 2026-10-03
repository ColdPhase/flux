/** Polls `probe` until it returns a truthy value, or fails after `timeoutMs`. */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}
