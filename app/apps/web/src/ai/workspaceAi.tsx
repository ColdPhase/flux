import { Children, cloneElement, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import { Link, useRouteLoaderData } from 'react-router';
import { WORKSPACE_AI_BLOCKED, type WorkspaceAiPolicy } from '@flux/contracts';
import type { ShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { EmptyState, Button } from '../ui';

// F-029 (#614, S3): the interface of a workspace whose AI is off is human-only. The shell loader carries
// `workspace.ai` for every workspace; this is the one place the web app reads it. A workspace the loader
// does not list is treated as allowed here: the server refuses AI work there anyway, and a blocked
// answer (`403 WORKSPACE_AI_BLOCKED`) makes the shell read the policy again.

/** The DOM event `request()` raises on `403 WORKSPACE_AI_BLOCKED`; the shell answers it by reading the policy again. */
export const AI_BLOCKED_EVENT = 'flux:workspace-ai-blocked';

export interface WorkspaceAiView {
  blocked: boolean;
  /** The workspace's name, for "AI is off in Garden club". */
  name: string;
  /** The person's role there: owners and admins can turn AI back on. */
  manager: boolean;
  ai: WorkspaceAiPolicy | null;
}

function useShell(): ShellData | undefined {
  return useRouteLoaderData('app') as ShellData | undefined;
}

/** Whether AI is off in one workspace, with what the blocked states need to say. */
export function useWorkspaceAi(workspaceId: string | null | undefined): WorkspaceAiView {
  const workspace = useShell()?.workspaces.find((space) => space.id === workspaceId);
  return {
    blocked: workspace?.ai?.state === 'blocked',
    name: workspace?.name ?? 'this workspace',
    manager: workspace?.role === 'owner' || workspace?.role === 'admin',
    ai: workspace?.ai ?? null,
  };
}

/** The workspaces whose AI is off. */
export function useBlockedWorkspaceIds(): ReadonlySet<string> {
  const workspaces = useShell()?.workspaces;
  // Stable while the shell's workspaces are, so effects that depend on it do not run again on every render.
  return useMemo(() => new Set((workspaces ?? []).filter((space) => space.ai?.state === 'blocked').map((space) => space.id)), [workspaces]);
}

/** True when AI is off in every workspace of the person (and they have at least one): nothing AI-shaped can start anywhere. */
export function useAllAiBlocked(): boolean {
  const workspaces = useShell()?.workspaces ?? [];
  return workspaces.length > 0 && workspaces.every((space) => space.ai?.state === 'blocked');
}

/** The project's workspace, from the shell's project list. */
export function useProjectWorkspaceId(projectId: string | null | undefined): string | undefined {
  return useShell()?.projects.find((project) => project.id === projectId)?.workspaceId;
}

/** Whether a project's workspace has AI off; a project the shell does not list is treated as allowed. */
export function useProjectAiBlocked(): (projectId: string | null | undefined) => boolean {
  const shell = useShell();
  return (projectId) => {
    const workspaceId = shell?.projects.find((project) => project.id === projectId)?.workspaceId;
    return shell?.workspaces.find((space) => space.id === workspaceId)?.ai?.state === 'blocked';
  };
}

/**
 * An AI surface (F-029): renders nothing while the workspace's AI is off, and marks the element
 * `data-ai-surface="<id>"` while it is on (the browser tests count these). A single DOM element child is
 * marked itself, so it takes no extra layout; anything else is wrapped in a box that has none.
 */
export function AiSurface({ workspaceId, id, children }: { workspaceId: string | null | undefined; id: string; children: ReactNode }) {
  const { blocked } = useWorkspaceAi(workspaceId);
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

/** True for the server's refusal of AI work in a workspace whose AI is off. */
export const isAiBlocked = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === WORKSPACE_AI_BLOCKED;

/**
 * The one calm blocked state for a direct link or an open tab to an AI place in a workspace whose AI is
 * off: nothing is launched, everything else works as usual. Owners and admins are pointed to People.
 */
export function AiOffState({ workspaceId, backTo, backLabel = 'Back', level = 2 }: { workspaceId: string | null | undefined; backTo: string; backLabel?: string; level?: 2 | 3 }) {
  const { name, manager } = useWorkspaceAi(workspaceId);
  const { openDetails } = useShellActions();
  return (
    <div className="view-empty ai-off" data-ai-off="">
      <EmptyState icon="spark" level={level} title={`AI is off in ${name}`}
        action={<>
          <Link className="ui-btn ui-btn--secondary" to={backTo}>{backLabel}</Link>
          {manager && workspaceId ? <Button variant="quiet" onClick={() => openDetails({ kind: 'people', workspaceId })}>People</Button> : null}
        </>}>
        <p>Its admins turned off agents and assistants here. Everything else works as usual.</p>
      </EmptyState>
    </div>
  );
}

/** "Not in Garden club: AI is off there." once per workspace whose AI is off, for the assistant card and the agent apps in Settings. */
export function AiOffThere({ className = 'sset-note' }: { className?: string }) {
  const shell = useShell();
  const off = (shell?.workspaces ?? []).filter((space) => space.ai?.state === 'blocked');
  if (!off.length || off.length === (shell?.workspaces.length ?? 0)) return null;
  return <>{off.map((space) => <p key={space.id} className={className} data-ai-off-there={space.id}>Not in {space.name}: AI is off there.</p>)}</>;
}

/** Settings → Agents and AI while AI is off in every workspace: one line each, and where an owner or admin turns it back on. */
export function AiOffEverywhere() {
  const shell = useShell();
  const { openDetails } = useShellActions();
  const off = (shell?.workspaces ?? []).filter((space) => space.ai?.state === 'blocked');
  return (
    <div className="ai-off-all" data-ai-off="">
      {off.map((space) => {
        const manager = space.role === 'owner' || space.role === 'admin';
        return (
          <p key={space.id} className="sset-note ai-off-all__line">
            <b>AI is off in {space.name}.</b> Its owners and admins can turn it back on{manager ? <> in <button type="button" className="ui-link" onClick={() => openDetails({ kind: 'people', workspaceId: space.id })}>People</button></> : null}.
          </p>
        );
      })}
    </div>
  );
}
