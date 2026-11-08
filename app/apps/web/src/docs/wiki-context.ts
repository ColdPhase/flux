import { createContext, useContext } from 'react';
import type { DocSummary, Project } from '@flux/contracts';

/** What every view inside a space's Wiki shares (#136, #869): the space, its pages and the one Markdown import. */
export interface WikiState {
  project: Project;
  /** The space's pages, the most recently changed first (the server's order). */
  docs: DocSummary[];
  /** Import a Markdown file: the one file chooser of the Wiki, under ⋯ (or on the empty Wiki). */
  importing: boolean;
  importError: string;
  /** The id of the refused import's message, for the controls it describes. */
  importErrorId: string;
  startImport(): void;
}

export const WikiContext = createContext<WikiState | null>(null);

export function useWiki(): WikiState {
  const wiki = useContext(WikiContext);
  if (!wiki) throw new Error('useWiki is used outside the project wiki');
  return wiki;
}
