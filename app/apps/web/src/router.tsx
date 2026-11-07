import { Navigate, Outlet, createBrowserRouter, redirect, useMatches, useRouteLoaderData, type RouteObject } from 'react-router';
import { useEffect, useState } from 'react';
import { markBooted } from './place/memory';
import { ToastProvider, markMotionReady } from './ui';
import { UpdatePrompt } from './pwa';
import { AppLayout } from './app/AppLayout';
import { appLoader, type ShellData } from './app/data';
import { ProjectConversation } from './conversations/ProjectConversation';
import { projectConversationLoader, shouldRevalidateProjectConversation } from './conversations/loader';
import { Booting, RouteCodeLoadError, RouteErrorPage } from './app/errors';
import { NotFoundView } from './app/views';
import { Home } from './app/Home';
import { LockedBoundary, LockedSpacePage } from './encryption/LockedSpace';
import { projectShellLoader } from './project/data';
import { docViewsPage, mapPage, tasksPage, wikiPage } from './app/viewChunks';
import {
  forgotPasswordAction,
  forgotPasswordLoader,
  redirectIfSignedIn,
  resetPasswordAction,
  signInAction,
  signOutAction,
  signOutLoader,
  signUpAction,
  signUpLoader,
} from './auth/logic';
import { AuthLayout, ForgotPasswordPage, ResetPasswordPage, SignInPage, SignOutPage, SignUpPage, ClaimPage } from './auth/pages';

// The settings layout and its sections share one download.
let settings: Promise<typeof import('./app/SettingsHome')> | undefined;
const settingsPage = () => settings ??= import('./app/SettingsHome');

// Paths and nesting stay eager so matching needs no download. A secondary route loads its
// existing component/data functions together, without changing their authority or revalidation.
// Its failure is contained inside the mounted shell instead of replacing it.
function secondary(load: Extract<NonNullable<RouteObject['lazy']>, () => Promise<unknown>>) {
  return {
    ErrorBoundary: RouteErrorPage,
    async lazy() {
      try { return await load(); }
      catch (cause) {
        // Router 8 retains route.lazy after a rejected module and renders HydrateFallback before
        // its error boundary. Finish registration, then fail the loader explicitly: no component,
        // destination data or successful action is invented. Reload resets the failed module cache.
        const error = new RouteCodeLoadError(cause);
        return { loader: () => { throw error; } };
      }
    },
  };
}
const sketch = secondary(async () => ({ Component: (await import('./sketch/SketchView')).SketchRoute }));
const material = secondary(async () => {
  const [page, data] = await Promise.all([import('./materials/MaterialView'), import('./materials/loader')]);
  return { Component: page.MaterialView, loader: data.materialLoader };
});

function Root() {
  // The first screen of this document is on show: from now on, Back and Forward are returns that find their place (#592).
  useEffect(() => { markBooted(); }, []);
  const shell = useRouteLoaderData('app') as ShellData | undefined;
  const inApp = useMatches().some((match) => match.id === 'app');
  const [session, setSession] = useState<string | null>(null);
  const observed = shell ? JSON.stringify([shell.me.user.id, shell.me.session.id]) : null;
  if (observed && observed !== session) setSession(observed);
  // Nothing moves while the first screen is put up (#593 AC-6). The shell's own first commit, not the boot screen's, is
  // the first screen (a deep link opens its panel a moment after it): motion starts a quarter of a second after it painted.
  const shown = !inApp || shell !== undefined;
  useEffect(() => {
    if (!shown) return undefined;
    let timer = 0;
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(markMotionReady, 250); });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [shown]);
  // A failed/offline loader is not proof of sign-out. Keep its last known scope
  // while the app route remains matched; auth routes or a confirmed new session retire it.
  const scopeKey = inApp ? observed ?? session : null;
  // The update prompt is shown on every page, signed in or not; reloading is the person's choice.
  // It is a row above the page, so it comes first: the shell below gives up the room it takes (#20).
  return <ToastProvider scopeKey={scopeKey}><UpdatePrompt /><Outlet /></ToastProvider>;
}

export const router = createBrowserRouter([
  {
    Component: Root,
    HydrateFallback: Booting,
    ErrorBoundary: RouteErrorPage,
    children: [
      {
        Component: AuthLayout,
        children: [
          // Better Auth sends a signed OAuth continuation here, including forced reauthentication.
          { path: 'login', action: signInAction, Component: SignInPage },
          { path: 'sign-in', loader: redirectIfSignedIn, action: signInAction, Component: SignInPage },
          { path: 'sign-up', loader: signUpLoader, action: signUpAction, Component: SignUpPage },
          { path: 'forgot-password', loader: forgotPasswordLoader, action: forgotPasswordAction, Component: ForgotPasswordPage },
          { path: 'reset-password', action: resetPasswordAction, Component: ResetPasswordPage },
          { path: 'claim', Component: ClaimPage },
          // An invite link (F-035): `/join#<token>`, signed in or not.
          { path: 'join', ...secondary(async () => ({ Component: (await import('./auth/JoinPage')).JoinPage })) },
          { path: 'sign-out', loader: signOutLoader, action: signOutAction, Component: SignOutPage },
          { path: 'connect-agent', ...secondary(async () => { const page = await import('./agent-connection/pages'); return { Component: page.AgentConnectionPage, loader: page.agentConnectionEntryLoader }; }) },
          { path: 'consent', ...secondary(async () => { const page = await import('./agent-connection/pages'); return { Component: page.AgentConsentPage, loader: page.agentConsentLoader }; }) },
          // Linked from notification email (#116); works without signing in.
          { path: 'unsubscribe', ...secondary(async () => ({ Component: (await import('./notifications/NotificationSettings')).UnsubscribePage })) },
        ],
      },
      {
        id: 'app',
        path: '/',
        loader: appLoader,
        Component: AppLayout,
        ErrorBoundary: RouteErrorPage,
        children: [{
          // F-030 (#655): a place whose workspace waits to be unlocked shows the locked panel inside the shell, at the same
          // address; any other error goes on to the page above.
          ErrorBoundary: LockedBoundary,
          children: [
          { index: true, Component: Home },
          { path: 'spaces/:workspaceId', Component: LockedSpacePage },
          { path: 'projects', ...secondary(async () => ({ Component: (await import('./app/ProjectsIndex')).ProjectsIndex })) },
          {
            // One project (#117): its header, audience, state line and view tabs share this data.
            id: 'project',
            path: 'projects/:projectId',
            loader: projectShellLoader,
            children: [
              // One conversation (UI116-1): the stream stays mounted while a root's thread opens beside it.
              { loader: projectConversationLoader, shouldRevalidate: shouldRevalidateProjectConversation, Component: ProjectConversation,
                children: [{ index: true }, { path: 'conversations/:conversationId' }] },
              // A message by its id alone (CW-2): the loader finds its thread and opens it there.
              { path: 'messages/:messageId', ...secondary(async () => ({ loader: (await import('./conversations/messageRoute')).messageLoader })) },
              { path: 'github', ...secondary(async () => ({ Component: (await import('./github/GithubSettings')).GithubSettings })) },
              // The space's settings (F-037, #874; ⋯ › Settings): its name, people, AI switch, Leave space and Delete space.
              { path: 'settings', ...secondary(async () => ({ Component: (await import('./people/SpaceSettings')).SpaceSettings })) },
              { path: 'tasks', ...secondary(async () => { const page = await tasksPage(); return { Component: page.ProjectTasks, loader: page.projectTasksLoader }; }) },
              { path: 'map', ...secondary(async () => ({ Component: (await mapPage()).ProjectMap })) },
              { path: 'map/:sketchId', ...sketch },
              {
                // The Wiki (#112, #869): the page, edited where it is read; its title switches pages.
                id: 'wiki',
                path: 'docs',
                ...secondary(async () => { const page = await wikiPage(); return { Component: page.WikiLayout, loader: page.wikiLoader, shouldRevalidate: page.wikiShouldRevalidate }; }),
                children: [
                  { index: true, ...secondary(async () => ({ Component: (await docViewsPage()).WikiHome })) },
                  { path: ':docId', ...secondary(async () => { const page = await docViewsPage(); return { Component: page.DocPage, loader: page.docLoader, shouldRevalidate: page.docShouldRevalidate }; }) },
                  { path: ':docId/versions/:version', ...secondary(async () => { const page = await docViewsPage(); return { Component: page.VersionPage, loader: page.docVersionLoader }; }) },
                  { path: ':docId/history', ...secondary(async () => { const page = await docViewsPage(); return { Component: page.DocHistory, loader: page.docHistoryLoader }; }) },
                ],
              },
              // An invitation's link (#62): opens the session's work with the invitation card.
              { path: 'live/:sessionId', ...secondary(async () => ({ Component: (await import('./live/LiveOpen')).LiveOpen })) },
            ],
          },
          { path: 'materials/:materialId', ...material },
          { path: 'materials/:materialId/versions/:version', ...material },
          { path: 'tasks', ...secondary(async () => ({ Component: (await import('./app/TasksView')).TasksView })) },
          { path: 'map', ...secondary(async () => ({ Component: (await import('./sketch/MyMap')).MyMap })) },
          { path: 'map/:sketchId', ...sketch },
          { path: 'docs', ...secondary(async () => ({ Component: (await docViewsPage()).WorkspaceDocs })) },
          { path: 'dm', ...secondary(async () => ({ Component: (await import('./dm/DmIndex')).DmIndex })) },
          { path: 'dm/new', ...secondary(async () => ({ Component: (await import('./dm/DmIndex')).NewDm })) },
          { path: 'dm/:dmId', ...secondary(async () => { const page = await import('./dm/DmConversation'); return { Component: page.DmConversation, loader: page.dmLoader }; }) },
          // A direct message has no maps (#866): its old Sketches addresses lead to the conversation.
          { path: 'dm/:dmId/sketches/*', loader: ({ params }) => redirect(`/dm/${params.dmId}`) },
          // An agent is a private conversation in Messages (F-036 AG-4, #857).
          { path: 'agents/:agentId', ...secondary(async () => ({ Component: (await import('./my-agents/AgentConversation')).AgentConversation })) },
          { path: 'inbox', ...secondary(async () => ({ Component: (await import('./notifications/InboxView')).InboxView })) },
          { path: 'inbox/:id', ...secondary(async () => ({ Component: (await import('./notifications/InboxView')).InboxOpen })) },
          // Settings (#350, F-026): every earlier address still opens its section.
          {
            path: 'settings',
            ...secondary(async () => ({ Component: (await settingsPage()).SettingsLayout })),
            children: [
              { index: true, ...secondary(async () => ({ Component: (await settingsPage()).SettingsHome })) },
              { path: 'appearance', ...secondary(async () => ({ Component: (await settingsPage()).SettingsAppearance })) },
              { path: 'account', ...secondary(async () => ({ Component: (await settingsPage()).SettingsAccount })) },
              { path: 'company', ...secondary(async () => ({ Component: (await settingsPage()).SettingsCompany })) },
              { path: 'notifications', ...secondary(async () => ({ Component: (await import('./notifications/NotificationSettings')).NotificationSettings })) },
              { path: 'notifications/verify', ...secondary(async () => ({ Component: (await import('./notifications/NotificationSettings')).VerifyAddress })) },
              { path: 'agents', ...secondary(async () => ({ Component: (await settingsPage()).SettingsAgents })) },
              // F-022 T4: the console and terminal load only when this route opens.
              { path: 'agents/claude-code', ...secondary(async () => ({ Component: (await import('./agent-runtime/ClaudeCodeSignIn')).ClaudeCodeSignIn })) },
              { path: 'assistant/claude-code', element: <Navigate to="/settings/agents/claude-code" replace /> },
              // #763 AG-2: managing your agent connections is a Settings page; `/connect-agent` without a client's sign-in leads here.
              { path: 'agents/connect', ...secondary(async () => { const page = await import('./agent-connection/pages'); return { Component: page.AgentConnectionSettings, loader: page.agentConnectionLoader }; }) },
              { path: 'agents/codex', ...secondary(async () => ({ Component: (await import('./agent-runtime/CodexSignIn')).CodexSignIn })) },
              // One of your agents (F-036 AG-1, #857).
              { path: 'agents/:agentId', ...secondary(async () => ({ Component: (await import('./my-agents/AgentPage')).AgentPage })) },
              { path: 'shortcuts', ...secondary(async () => ({ Component: (await settingsPage()).KeyboardShortcuts })) },
              // Assistant's schedules and reactions, until #858 moves schedules into its conversation and removes reactions.
              { path: 'assistant', ...secondary(async () => ({ Component: (await import('./assistant/AssistantSettings')).AssistantSettings })) },
              { path: 'background-compute', ...secondary(async () => { const page = await import('./proactive-comparison/BackgroundComputeSettings'); return { Component: page.BackgroundComputeSettings, loader: page.backgroundComputeLoader }; }) },
              { path: 'ai-connections', ...secondary(async () => { const page = await import('./proactive-comparison/BackgroundComputeSettings'); return { Component: page.AiConnectionsSettings, loader: page.aiConnectionsLoader }; }) },
            ],
          },
          // The header names it as such (#763 NV-1): it is no place of the sidebar.
          { path: '*', Component: NotFoundView, handle: { notFound: true } },
          ],
        }],
      },
    ],
  },
]);
