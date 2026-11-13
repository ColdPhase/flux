import { createContext, useContext } from 'react';
import type { ConversationMessage, ObjectRef, WorkStatus } from '@flux/contracts';

/** A project object shown in the Details panel (#101). */
export interface ObjectView {
  kind: 'work' | 'decision'; id: string; projectId?: string;
  /** The title of the task, when the opener has it (its row or card): the panel's loading state shows it in its own place at once (#863 rule 6). */
  title?: string;
}
/** A form in the Details panel that starts from a message or a work item, keeping the source in place. */
export interface WorkFormView {
  kind: 'propose-decision';
  projectId: string;
  source?: { messageId: string; text: string };
  /** A title typed in the composer (`/decide …`), when there is no message to start from. */
  title?: string;
  workId?: string;
}

/** "Add to docs" for a decision (#112); `inDocs` are the docs that already have it. */
export interface AddToDocView {
  kind: 'add-to-doc';
  projectId: string;
  from: { type: 'decision'; id: string; title: string };
  inDocs: string[];
  /** False when IDs describe one bounded relation page, rather than every linked doc. */
  inDocsComplete?: boolean;
}

/**
 * What one message is linked to, in Details (#117): the tasks and decisions made from it, and their sources, thoughts and Wiki pages.
 */
export interface OverviewView {
  kind: 'overview';
  messageId: string;
  /** One already loaded native message; never a project collection or an authority proof. */
  selection?: { accountId: string; projectId: string; message: ConversationMessage };
}

/** The people of one workspace (#188): members and roles; owners and admins add and manage them. */
/** `project`: opened from a project's Invite, so a new link also opens that project (#763 FT-3). */
/** The people and keys of an encrypted space (F-030), still its own internal workspace. */
export interface PeopleView { kind: 'people'; workspaceId: string }

/** A new space (F-030, #655): the form in the Details panel, plain or encrypted. Never kept in a history entry: it holds a password. */

/** "Make it a project…" for a DM sketch (#96): the exact audience and content before anything is shared. */

/**
 * A thought's linked tasks (#170) in the one panel, in place of the phone's own sheet: each task replaces this content
 * with its own details, and "back" returns here.
 */
export interface ThoughtTasksView {
  kind: 'thought-tasks';
  projectId: string;
  thought: { id: string; text: string };
  entry: import('../sketch/ThoughtTasks').ThoughtTasksEntry;
}

/** The content of the panel when the current view owns it (a thread, an agent): the view renders it into the panel's slot. */
export interface OwnedView { kind: 'owned' }
export const isOwned = (view: DetailsView): view is OwnedView => typeof view === 'object' && view.kind === 'owned';

/** What the Details panel shows: the current place, a project object or form, or how to connect a personal AI (#57). */
export type DetailsView = 'place' | 'connect-ai' | ObjectView | WorkFormView | AddToDocView | OverviewView | PeopleView | ThoughtTasksView | OwnedView;

/**
 * A panel a route's own view owns (F-026 S4, #488): a conversation thread, a direct-message thread, an agent or a task's
 * thread. It is the same one panel as a task's: the view registers it, the shell shows its head and close, and the view
 * renders the content into the panel's slot (`useOwnedPanel`), so its state and drafts stay where they were.
 */
export interface OwnedPanel {
  /** Identity: another key replaces the content, the same key keeps it. */
  key: string;
  /** The kind in the head ("Thread", "Agent") and the surface's name ("Replies", "Agent"). */
  chip: string;
  label: string;
  /** The close control's name when "Close <label>" does not say it (a long title). */
  closeLabel?: string;
  /** "‹ Task #1": a way back to where the person came from; the label is its name. */
  back?: { label: string; run: () => void };
  /** The page a reference was followed from, for a panel that covers the header where its control sits (#592): shown only when no step in the panel leads back. */
  origin?: { label: string; run: () => void };
  /** Esc and the close control: the view updates its address and stops registering the panel. `keepPanel`: the panel stays for what replaces it. */
  onClose: (options?: { keepPanel?: boolean }) => void;
  /** On a phone it opens at full height (a thread); the height then stays while the content changes. */
  startFull?: boolean;
}

/** What the one Create window opens with (F-026 S3): everything is optional; the person completes the rest. */
export interface CreateRequest {
  /** The five types (#867): `task` goes straight to the task form, `space` to the New space window (#763 FR-2), `decision` to the decision
   * form, `thought` to a thought on My map (#866) and `page` to a new Wiki page; without it the phone sheet first asks what to create. */
  kind?: 'task' | 'space' | 'decision' | 'thought' | 'page';
  projectId?: string;
  title?: string;
  status?: WorkStatus;
  /** What the task comes from (a message or the thoughts of a Map selection): linked, never moved or copied. */
  sources?: { ref: ObjectRef; label: string }[];
  /** Called once the task exists, e.g. a `/task` command consumes its composer text only then (closing the window keeps it). */
  onCreated?: () => void;
}

export interface ShellActions {
  /**
   * Opens an object or place in the one panel. `back: 'push'`, from content inside the panel, replaces the object shown
   * and leaves "‹ back" to it; `'keep'` is the way back itself; otherwise it starts afresh.
   */
  openDetails(view?: DetailsView, options?: { back?: 'push' | 'keep' }): void;
  /** The open object names itself for the way back from the next one ("Task #2"). */
  labelPanel(label: string | null): void;
  /** Opens the Create window on the computer, or the Create sheet on the phone (#345): the one way to create. */
  openCreate(request?: CreateRequest): void;
  /** Opens Search (⌘K), the one search across everything the person may open (#114). */
  openSearch(): void;
  /** Opens the navigation drawer on a narrow screen, where the projects are listed. */
  openNavigation(): void;
  /** A place in the header where the current view can put one quiet action (a DM's Select, #96). */
  actionSlot: HTMLElement | null;
  /** A project view's quiet context beside its title, such as the compact Wiki's page count. */
  metadataSlot: HTMLElement | null;
  /** Shows a view-owned panel (a thread, an agent) in the one panel; see `OwnedPanel` and `useOwnedPanel`. */
  showPanel(panel: OwnedPanel): void;
  /** The view stopped owning that panel: it closes unless the panel already shows something else. */
  hidePanel(key: string): void;
  /** Closes the panel as Esc and its close control do: a view-owned panel leaves its address first. */
  closePanel(): void;
  /**
   * A panel content that must not be dismissed by accident (the one-time recovery code, UI audit RC-1) holds Esc and ×:
   * while its guard returns true, closing is refused and the content asks in place. Null releases it.
   */
  guardPanel(guard: (() => boolean) | null): void;
  /** Shows that view-owned panel again when something else closed or covered it while the view kept it open. */
  reopenPanel(key: string): void;
  /** The element inside the panel the owner renders into, while the panel shows the owned view. */
  panelSlot: HTMLElement | null;
  /** The key of the view-owned panel the panel shows now, or null. */
  panelKey: string | null;
}

export const ShellContext = createContext<ShellActions>({ openDetails: () => undefined, labelPanel: () => undefined, openCreate: () => undefined, openSearch: () => undefined, openNavigation: () => undefined, actionSlot: null, metadataSlot: null, showPanel: () => undefined, hidePanel: () => undefined, reopenPanel: () => undefined, closePanel: () => undefined, guardPanel: () => undefined, panelSlot: null, panelKey: null });

export function useShellActions(): ShellActions {
  return useContext(ShellContext);
}
