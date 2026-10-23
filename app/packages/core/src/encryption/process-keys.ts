import { KeyringUnavailableError, SwapUnsafeError } from './errors.js';
import { WorkspaceKey } from './keys.js';
import type { KeyringPort } from './keyring-client.js';
import type { SwapVerdict } from './swap.js';

/** One `workspace_unlocks` row: a live DEK version sealed under a keyring boot key. */
export interface UnlockRow {
  keyVersion: number;
  bootId: string;
  sealedDek: string;
  unlockedAt: Date;
  unlockedBy: string | null;
}

const NEGATIVE_CACHE_MS = 2_000;

export type EncryptionAvailability = 'ok' | 'keyring_off' | 'keyring_unavailable' | 'swap_unsafe';

/**
 * The unlocked keys of one API or worker process (F-030 Every content operation, Heartbeat). Created once in the
 * composition root and passed in; nothing else holds DEKs. It knows the keyring's last boot id (refreshed by the 5 s
 * heartbeat, which also runs `swapSafety()` again) and caches each opened DEK by `(workspace, version, boot id,
 * unlocked at)`, so a re-unlock or a new boot never reuses an old entry. While swap is possible, or before the keyring
 * was ever reached, it opens nothing: every sealed workspace is then locked here.
 */
export class ProcessKeys {
  private known: string | null = null;
  private verdict: SwapVerdict;
  private reached = false;
  /** When the keyring last failed to answer: a short negative cache, so a down keyring does not cost every request a timeout. */
  private failedAt = 0;
  private readonly cache = new Map<string, WorkspaceKey>();
  private readonly forgetListeners: ((workspaceId: string | null) => void)[] = [];

  constructor(private readonly keyring: KeyringPort | null, private readonly swap: () => SwapVerdict) {
    this.verdict = swap();
  }

  /** The keyring boot this process last saw; null before the first answer, or with no keyring. */
  get bootId(): string | null { return this.known; }
  get swapSafe(): boolean { return this.verdict.safe; }
  /** The boot under which this process can open keys now: null while swap is unsafe or before the keyring answered. */
  get openableBoot(): string | null { return this.verdict.safe ? this.known : null; }

  get availability(): EncryptionAvailability {
    if (!this.keyring) return 'keyring_off';
    if (!this.verdict.safe) return 'swap_unsafe';
    return this.known && this.reached ? 'ok' : 'keyring_unavailable';
  }

  /** Throws the 503 that unlock and creation answer when this process cannot hold a key. */
  requireAvailable(): void {
    if (!this.verdict.safe) throw new SwapUnsafeError();
    if (!this.keyring || !this.known) throw new KeyringUnavailableError();
  }

  /** Called when this process drops keys: one workspace, or all (null) on a new boot or unsafe swap. Live rooms and indexes close here (S2b). */
  onForget(listener: (workspaceId: string | null) => void) { this.forgetListeners.push(listener); }

  /**
   * One heartbeat: swap again, then the boot id. An unreachable keyring keeps cached keys in use (availability, not
   * secrecy, is at stake); a different boot drops every cached key. Returns the boot change, if any.
   */
  async refresh(options: { force?: boolean } = {}): Promise<{ previous: string | null; current: string | null; observedAt: Date } | null> {
    const wasSafe = this.verdict.safe;
    this.verdict = this.swap();
    if (wasSafe && !this.verdict.safe) this.forget(null);
    if (!this.keyring) return null;
    if (!options.force && Date.now() - this.failedAt < NEGATIVE_CACHE_MS) return null;
    let current: string;
    try { current = await this.keyring.boot(); } catch { this.failedAt = Date.now(); return null; }
    this.failedAt = 0;
    this.reached = true;
    const previous = this.known;
    if (previous === current) return null;
    this.known = current;
    this.forget(null);
    return { previous, current, observedAt: new Date() };
  }

  /** Starts the 5 s heartbeat; `onBootChange` deletes the stale rows and records the locks. Returns the stop function. */
  startHeartbeat(onBootChange: (change: { previous: string | null; current: string | null; observedAt: Date }) => Promise<void>, intervalMs = 5_000,
    onError?: (error: unknown) => void) {
    let running = false;
    const beat = async () => {
      if (running) return;
      running = true;
      try {
        const change = await this.refresh({ force: true });
        if (change) await onBootChange(change);
      } catch (error) { onError?.(error); } finally { running = false; }
    };
    const timer = setInterval(() => { void beat(); }, intervalMs);
    timer.unref();
    return { first: beat(), stop: () => clearInterval(timer) };
  }

  /**
   * The key of one live version from its unlock row. The row must be of the boot this process knows; otherwise the
   * caller treats the workspace as locked.
   */
  async key(workspaceId: string, row: UnlockRow): Promise<WorkspaceKey> {
    if (!this.keyring || !this.verdict.safe || row.bootId !== this.known) throw new KeyringUnavailableError();
    const name = `${workspaceId}:${row.keyVersion}:${row.bootId}:${row.unlockedAt.getTime()}`;
    const cached = this.cache.get(name);
    if (cached) return cached;
    const dek = await this.keyring.open(workspaceId, row.keyVersion, row.bootId, row.sealedDek);
    try {
      const key = WorkspaceKey.fromDek(workspaceId, row.keyVersion, dek);
      this.cache.set(name, key);
      return key;
    } finally { dek.fill(0); }
  }

  /** Seals a DEK under the keyring's boot key for an unlock row. */
  async sealForUnlock(workspaceId: string, keyVersion: number, dek: Buffer): Promise<{ bootId: string; sealed: string }> {
    this.requireAvailable();
    const result = await this.keyring!.seal(workspaceId, keyVersion, dek);
    if (result.bootId !== this.known) {
      // The keyring restarted since the last heartbeat: adopt its boot and drop what was cached under the old one.
      this.known = result.bootId;
      this.forget(null);
    }
    return result;
  }

  /** Drops (and so releases) the cached keys of one workspace, or of all. */
  forget(workspaceId: string | null) {
    for (const name of [...this.cache.keys()]) if (workspaceId === null || name.startsWith(`${workspaceId}:`)) this.cache.delete(name);
    for (const listener of this.forgetListeners) listener(workspaceId);
  }
}
