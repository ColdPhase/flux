import { ServiceUnavailableError } from '../access/errors.js';

const busy = () => new ServiceUnavailableError('Too many unlocks at once; try again in a moment', 'UNLOCK_BUSY');

/**
 * The derivation semaphore (F-030 Password checks): at most two Argon2id derivations (64 MiB each) run at once per
 * API process, across every route that checks a password or the recovery code and encrypted-space creation. Others
 * queue; the ninth waiting request answers `503 UNLOCK_BUSY`. **One per person:** a person has at most one derivation
 * running or waiting; another of theirs at the same moment answers `503 UNLOCK_BUSY` at once, so one account cannot
 * hold both slots and the queue (S3 security review). One instance per process, created in the composition root.
 */
export class DerivationSemaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly people = new Set<string>();

  constructor(readonly slots = 2, readonly maxWaiting = 8) {}

  /** For tests and health: how many run and wait now. */
  get load() { return { active: this.active, waiting: this.waiting.length, people: this.people.size }; }

  async run<T>(person: string, work: () => Promise<T>): Promise<T> {
    if (this.people.has(person)) throw busy();
    if (this.active >= this.slots && this.waiting.length >= this.maxWaiting) throw busy();
    this.people.add(person);
    try {
      if (this.active >= this.slots) await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.active += 1;
      try {
        return await work();
      } finally {
        const next = this.waiting.shift();
        if (next) next(); // the slot passes straight to the next waiter
        else this.active -= 1;
      }
    } finally {
      this.people.delete(person);
    }
  }
}
