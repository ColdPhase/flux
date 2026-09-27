import { createContext, useContext } from 'react';

/** A project object shown in the Details panel (#101). */
export interface ObjectView { kind: 'work' | 'decision' | 'result'; id: string }
/** A form in the Details panel that starts from a message or a work item, keeping the source in place. */
export interface WorkFormView {
  kind: 'propose-decision' | 'attach-result';
  projectId: string;
  source?: { messageId: string; text: string };
  workId?: string;
}

/** What the Details panel shows: the current place, a project object or form, or how to connect a personal AI (#57). */
export type DetailsView = 'place' | 'connect-ai' | ObjectView | WorkFormView;

export interface ShellActions {
  openDetails(view?: DetailsView): void;
}

export const ShellContext = createContext<ShellActions>({ openDetails: () => undefined });

export function useShellActions(): ShellActions {
  return useContext(ShellContext);
}
