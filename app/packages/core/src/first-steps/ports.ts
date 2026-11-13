import type { WorkspaceRole } from '@flux/contracts';

/** What Home's first-steps card reads about a person (#1438). `@flux/db`'s `firstStepRows` implements it, scoped to that person. */
export interface FirstStepRows {
  /**
   * The company the person is in, with their role there, since when (`joinedAt`), its name, its Everyone space and whether the card is done for
   * them (hidden by them or finished); null outside one.
   */
  company(userId: string): Promise<{ id: string; name: string; role: WorkspaceRole; joinedAt: Date; everyoneSpaceId: string | null; hidden: boolean } | null>;
  /** Someone else is in the company, or an invite link to it was ever made. */
  invitedAnyone(companyId: string): Promise<boolean>;
  /** The person has an AI connection of their own: an API key, or an agent app or plan connection, not removed. */
  aiConnected(userId: string): Promise<boolean>;
  /** The person wrote a message in a space of the company. */
  wroteMessage(userId: string, companyId: string): Promise<boolean>;
  hasPhoto(userId: string): Promise<boolean>;
  /** Marks the card done for good, on every device (the person hid it, or no step is left); a second call keeps the first time. */
  hide(userId: string, at: Date): Promise<void>;
}
