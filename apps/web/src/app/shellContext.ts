import { createContext, useContext } from 'react';

/** What the Details panel shows: the current place, or how to connect a personal AI (#57). */
export type DetailsView = 'place' | 'connect-ai';

export interface ShellActions {
  openDetails(view?: DetailsView): void;
}

export const ShellContext = createContext<ShellActions>({ openDetails: () => undefined });

export function useShellActions(): ShellActions {
  return useContext(ShellContext);
}
