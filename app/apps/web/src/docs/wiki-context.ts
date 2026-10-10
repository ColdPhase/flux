import { createContext, useContext } from 'react';
import type { DocSummary, Project } from '@flux/contracts';

/** What every view inside the project wiki shares (#136): the project, its pages and focus mode. */
export interface WikiState {
  project: Project;
  /** The project's pages, the most recently changed first (the server's order). */
  docs: DocSummary[];
  writable: boolean;
  /** Focus mode hides the page index so the document has the room ("fullscreen"). */
  focus: boolean;
  setFocus(next: boolean): void;
  /** The wiki is narrow (a phone): pages are a chip row and the page's actions sit in one menu. */
  compact: boolean;
}

export const WikiContext = createContext<WikiState | null>(null);

export function useWiki(): WikiState {
  const wiki = useContext(WikiContext);
  if (!wiki) throw new Error('useWiki is used outside the project wiki');
  return wiki;
}
