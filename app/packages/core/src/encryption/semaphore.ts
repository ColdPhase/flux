import { ServiceUnavailableError } from '../access/errors.js';

/**
 * The derivation semaphore (F-030 Password checks): at most two Argon2id derivations (64 MiB each) run at once per
 * API process, across every route that checks a password or the recovery code. Others queue; the ninth waiting
 * request answers `503 UNLOCK_BUSY`. One instance per process, created in the composition root.
 */
export class DerivationSemaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly slots = 2, readonly maxWaiting = 8) {}

  /** For tests and health: how many run and wait now. */
  get load() { return { active: this.active, waiting: this.waiting.length }; }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) {
      if (this.waiting.length >= this.maxWaiting) throw new ServiceUnavailableError('Too many unlocks at once; try again in a moment', 'UNLOCK_BUSY');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.active -= 1;
    }
  }
}
