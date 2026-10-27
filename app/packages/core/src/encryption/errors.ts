import { DomainError, InvalidInputError, ServiceUnavailableError } from '../access/errors.js';

/** `423 WORKSPACE_LOCKED`: the sealed workspace has no unlocked key in this process. No partial body. */
export class WorkspaceLockedError extends DomainError {
  constructor(workspaceId: string, name: string) {
    super(423, 'WORKSPACE_LOCKED', `${name} is waiting to be unlocked.`);
    this.details = { message: this.message, details: { workspaceId } };
  }
}

export class KeyringUnavailableError extends ServiceUnavailableError {
  constructor() {
    super('Encrypted spaces are not available on this server right now: its keyring cannot be reached', 'KEYRING_UNAVAILABLE');
  }
}

export class SwapUnsafeError extends ServiceUnavailableError {
  constructor() {
    super('This server can write memory to disk. Its operator needs to turn off swap or confirm it is encrypted.', 'SWAP_UNSAFE');
  }
}

export class UnlockIncorrectError extends InvalidInputError {
  constructor(name: string) {
    super(`That password doesn't unlock ${name}.`, 'UNLOCK_INCORRECT');
  }
}

/** A missing wrap or key for a live version is a bug: a 500 with a code only, never a partial unlock. */
export class EncryptionInvariantError extends DomainError {
  constructor() {
    super(500, 'ENCRYPTION_KEYS_INCOMPLETE', 'The workspace keys are incomplete');
  }
}
