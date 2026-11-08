import type { WorkspaceRole } from '@flux/contracts';
import { ConflictError } from './errors.js';

/**
 * Who may be in an encrypted space (C-24): someone who is in the company now and is not its guest. One check for the three ways in:
 * the space's creation, adding a person and bringing a removed person back. `companyRole` is the person's role in the company, read with
 * the membership row held, so leaving the company waits for the change that needs it.
 */
export function requireSpacePerson(companyRole: WorkspaceRole | null): void {
  if (!companyRole) throw new ConflictError('Only people in the company can be added to this space', 'NOT_A_MEMBER');
  if (companyRole === 'guest') throw new ConflictError('Guests cannot be in an encrypted space', 'ENCRYPTED_SPACE_NO_GUESTS');
}
