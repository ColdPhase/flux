import type { WorkspaceRole } from '@flux/contracts';

/** What Home's first-steps card reads about a person (#1438). `@flux/db`'s `firstStepRows` implements it, scoped to that person. */
export interface FirstStepRows {
  /** The company the person is in, with their role there, its name, its Everyone space and whether they hid the card; null outside one. */
  company(userId: string): Promise<{ id: string; name: string; role: WorkspaceRole; everyoneSpaceId: string | null; hidden: boolean } | null>;
  /** Someone else is in the company, or an invite link to it was ever made. */
  invitedAnyone(companyId: string): Promise<boolean>;
  /** The person has an AI connection of their own: an API key, or an agent app or plan connection, not removed. */
  aiConnected(userId: string): Promise<boolean>;
  /** The person wrote a message in a space of the company. */
  wroteMessage(userId: string, companyId: string): Promise<boolean>;
  hasPhoto(userId: string): Promise<boolean>;
  /** Hides the card for good; a second call changes nothing. */
  hide(userId: string, at: Date): Promise<void>;
}
