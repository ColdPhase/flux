import { createContext, useContext } from 'react';
import type { ConversationMessage } from '@flux/contracts';

/** A project object shown in the Details panel (#101). */
export interface ObjectView { kind: 'work' | 'decision' | 'result'; id: string; projectId?: string }
/** A form in the Details panel that starts from a message or a work item, keeping the source in place. */
export interface WorkFormView {
  kind: 'propose-decision' | 'attach-result';
  projectId: string;
  source?: { messageId: string; text: string };
  workId?: string;
}

/** "Add to docs" for a result or decision (#112); `inDocs` are the docs that already have it. */
export interface AddToDocView {
  kind: 'add-to-doc';
  projectId: string;
  from: { type: 'result' | 'decision'; id: string; title: string };
  inDocs: string[];
  /** False when IDs describe one bounded relation page, rather than every linked doc. */
  inDocsComplete?: boolean;
}

/**
 * The project's overview in Details (#117): linked work, decisions, results, sources and
 * sketches of the open conversation, or of one message when `messageId` is set.
 */
export interface OverviewView {
  kind: 'overview';
  messageId?: string;
  /** One already loaded native message; never a project collection or an authority proof. */
  selection?: { accountId: string; projectId: string; message: ConversationMessage };
  /** `people` scrolls to "Who can see this" and moves focus there (#188): the header's audience line. */
  focus?: 'people';
}

/** The people of one workspace (#188): members and roles; owners and admins add and manage them. */
export interface PeopleView { kind: 'people'; workspaceId: string }

/** "Make it a project…" for a DM sketch (#96): the exact audience and content before anything is shared. */
export interface PromoteSketchView { kind: 'promote-sketch'; sketchId: string; title: string }

/** "What matters" (#133): the private recap of one project. */
export interface RecapView { kind: 'recap'; projectId: string }

/** What the Details panel shows: the current place, a project object or form, or how to connect a personal AI (#57). */
export type DetailsView = 'place' | 'connect-ai' | ObjectView | WorkFormView | AddToDocView | OverviewView | PromoteSketchView | RecapView | PeopleView;

export interface ShellActions {
  openDetails(view?: DetailsView): void;
  /** Opens Jump to… (⌘K), the search across everything the person may open (#114). */
  openSearch(): void;
  /** A place in the header where the current view can put one quiet action (a DM's Select, #96). */
  actionSlot: HTMLElement | null;
}

export const ShellContext = createContext<ShellActions>({ openDetails: () => undefined, openSearch: () => undefined, actionSlot: null });

export function useShellActions(): ShellActions {
  return useContext(ShellContext);
}
