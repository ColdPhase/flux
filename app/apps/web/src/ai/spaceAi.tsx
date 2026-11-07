import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Link, useRouteLoaderData } from 'react-router';
import { SPACE_AI_OFF } from '@flux/contracts';
import type { ShellData } from '../app/data';
import { EmptyState } from '../ui';

// AG-10 (F-037; it replaces the workspace AI lock of F-029): the AI switch of a space. Each space has its own, on by default,
// and there is no global one. While it is off, the space is human-only: no agent, no `/ai`, no suggestion. The shell loader
// carries `ai` on every space it lists; this is the one place the web app reads it. A space the loader does not list is treated
// as allowed here: the server refuses AI work there anyway, and a refusal (`403 SPACE_AI_OFF`) makes the shell read it again.

/** The DOM event `request()` raises on `403 SPACE_AI_OFF`; the shell answers it by reading the spaces again. */
export const AI_BLOCKED_EVENT = 'flux:space-ai-off';

export interface SpaceAiView {
  blocked: boolean;
  /** The space's name, for "AI is off in Payroll". */
  name: string;
  /** The person manages the space (its admin, or a company owner or admin): they turn AI back on in its settings. */
  manager: boolean;
}

function useShell(): ShellData | undefined {
  return useRouteLoaderData('app') as ShellData | undefined;
}

/** Whether AI is off in one space, with what the blocked states need to say. */
export function useSpaceAi(projectId: string | null | undefined): SpaceAiView {
  const space = useShell()?.reachableSpaces.find((project) => project.id === projectId);
  return { blocked: space?.ai === 'blocked', name: space?.name ?? 'this space', manager: space?.access === 'manager' };
}

/** True when AI is off in every space of the person (and they have at least one): nothing AI-shaped can start anywhere. */
export function useAllAiBlocked(): boolean {
  const spaces = useShell()?.projects ?? [];
  return spaces.length > 0 && spaces.every((space) => space.ai === 'blocked');
}

/** Whether a space has AI off; a space the shell does not list is treated as allowed. */
export function useProjectAiBlocked(): (projectId: string | null | undefined) => boolean {
  const shell = useShell();
  return (projectId) => shell?.reachableSpaces.find((project) => project.id === projectId)?.ai === 'blocked';
}

/**
 * An AI surface (AG-10): renders nothing while the space's AI is off, and marks the element
 * `data-ai-surface="<id>"` while it is on (the browser tests count these). A single DOM element child is
 * marked itself, so it takes no extra layout; anything else is wrapped in a box that has none.
 */
export function AiSurface({ projectId, id, children }: { projectId: string | null | undefined; id: string; children: ReactNode }) {
  const { blocked } = useSpaceAi(projectId);
  if (blocked) return null;
  return <>{markAi(children, id)}</>;
}

/** Marks a rendered AI element (or its box) for the browser tests; use where a hook already knows AI is allowed. */
export function markAi(children: ReactNode, id: string): ReactNode {
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  if (isValidElement(only) && typeof only.type === 'string') return cloneElement(only as ReactElement<Record<string, unknown>>, { 'data-ai-surface': id });
  return <span style={{ display: 'contents' }} data-ai-surface={id}>{children}</span>;
}

/** The marker attribute for an element rendered by code that already knows AI is allowed. */
export const aiMark = (id: string) => ({ 'data-ai-surface': id });

/** True for the server's refusal of AI work in a space whose AI is off. */
export const isAiBlocked = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === SPACE_AI_OFF;

/**
 * The one calm blocked state for a direct link or an open tab to an AI place in a space whose AI is off: nothing is launched,
 * everything else works as usual. A space's admins are pointed to its settings, where the switch is.
 */
export function AiOffState({ projectId, backTo, backLabel = 'Back', level = 2 }: { projectId: string | null | undefined; backTo: string; backLabel?: string; level?: 2 | 3 }) {
  const { manager } = useSpaceAi(projectId);
  return (
    <div className="pane-scroll"><div className="pane-in">
    <div className="view-empty ai-off" data-ai-off="">
      <EmptyState icon="lock" level={level} title="AI is off in this space"
        action={<>
          <Link className="ui-btn ui-btn--secondary" to={backTo}>{backLabel}</Link>
          {manager && projectId ? <Link className="ui-btn ui-btn--quiet" to={`/projects/${projectId}/settings`}>Space settings</Link> : null}
        </>}>
        <p>Its admins turned off agents here. Everything else works as usual.</p>
      </EmptyState>
    </div>
    </div></div>
  );
}
