import { useState } from 'react';
import { Outlet, createBrowserRouter, useMatches, useRouteLoaderData, type RouteObject } from 'react-router';
import { ToastProvider } from './ui';
import { UpdatePrompt } from './pwa';
import { AppLayout } from './app/AppLayout';
import { appLoader, type ShellData } from './app/data';
import { ProjectConversation, projectConversationLoader, shouldRevalidateProjectConversation } from './app/ProjectConversation';
import { Booting, RouteCodeLoadError, RouteErrorPage } from './app/errors';
import { ConversationView, NotFoundView } from './app/views';
import { projectShellLoader } from './project/data';
import {
  forgotPasswordAction,
  forgotPasswordLoader,
  redirectIfSignedIn,
  resetPasswordAction,
  signInAction,
  signOutAction,
  signOutLoader,
  signUpAction,
} from './auth/logic';
import { AuthLayout, ForgotPasswordPage, ResetPasswordPage, SignInPage, SignOutPage, SignUpPage } from './auth/pages';

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
const docReader = secondary(async () => {
  const page = await import('./docs/DocViews');
  return { Component: page.DocReader, loader: page.docLoader };
});
const docEditor = secondary(async () => {
  const page = await import('./docs/DocEditor');
  return { Component: page.DocEditor, loader: page.docEditLoader };
});
const sketch = secondary(async () => ({ Component: (await import('./sketch/SketchView')).SketchRoute }));
const material = secondary(async () => {
  const page = await import('./app/MaterialView');
  return { Component: page.MaterialView, loader: page.materialLoader };
});

function Root() {
  const shell = useRouteLoaderData('app') as ShellData | undefined;
  const inApp = useMatches().some((match) => match.id === 'app');
  const [session, setSession] = useState<string | null>(null);
  const observed = shell ? JSON.stringify([shell.me.user.id, shell.me.session.id]) : null;
  if (observed && observed !== session) setSession(observed);
  // A failed/offline loader is not proof of sign-out. Keep its last known scope
  // while the app route remains matched; auth routes or a confirmed new session retire it.
  const scopeKey = inApp ? observed ?? session : null;
  // The update prompt is shown on every page, signed in or not; reloading is the person's choice.
  return <ToastProvider scopeKey={scopeKey}><Outlet /><UpdatePrompt /></ToastProvider>;
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
          { path: 'sign-up', loader: redirectIfSignedIn, action: signUpAction, Component: SignUpPage },
          { path: 'forgot-password', loader: forgotPasswordLoader, action: forgotPasswordAction, Component: ForgotPasswordPage },
          { path: 'reset-password', action: resetPasswordAction, Component: ResetPasswordPage },
          { path: 'sign-out', loader: signOutLoader, action: signOutAction, Component: SignOutPage },
          { path: 'connect-agent', ...secondary(async () => { const page = await import('./agent-connection/pages'); return { Component: page.AgentConnectionPage, loader: page.agentConnectionLoader }; }) },
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
        children: [
          { index: true, Component: ConversationView },
          { path: 'projects', ...secondary(async () => ({ Component: (await import('./app/ProjectsIndex')).ProjectsIndex })) },
          { path: 'projects/new', ...secondary(async () => ({ Component: (await import('./app/ProjectSetup')).ProjectSetup })) },
          {
            // One project (#117): its header, audience, state line and view tabs share this data.
            id: 'project',
            path: 'projects/:projectId',
            loader: projectShellLoader,
            children: [
              // One conversation (UI116-1): the stream stays mounted while a root's thread opens beside it.
              { loader: projectConversationLoader, shouldRevalidate: shouldRevalidateProjectConversation, Component: ProjectConversation,
                children: [{ index: true }, { path: 'conversations/:conversationId' }] },
              { path: 'github', ...secondary(async () => ({ Component: (await import('./github/GithubSettings')).GithubSettings })) },
              { path: 'tasks', ...secondary(async () => { const page = await import('./work/ProjectTasks'); return { Component: page.ProjectTasks, loader: page.projectTasksLoader }; }) },
              { path: 'map', ...secondary(async () => ({ Component: (await import('./project/ProjectViews')).ProjectMap })) },
              { path: 'map/:sketchId', ...sketch },
              {
                // The wiki (#112) as two panes (#136): the page index beside the open page.
                id: 'wiki',
                path: 'docs',
                ...secondary(async () => { const page = await import('./docs/Wiki'); return { Component: page.WikiLayout, loader: page.wikiLoader, shouldRevalidate: page.wikiShouldRevalidate }; }),
                children: [
                  { index: true, ...secondary(async () => ({ Component: (await import('./docs/DocViews')).WikiHome })) },
                  { path: 'new', ...docEditor },
                  { path: ':docId', ...docReader },
                  { path: ':docId/versions/:version', ...docReader },
                  { path: ':docId/edit', ...docEditor },
                  { path: ':docId/history', ...secondary(async () => { const page = await import('./docs/DocViews'); return { Component: page.DocHistory, loader: page.docHistoryLoader }; }) },
                ],
              },
              // Agents (UI116-2, #136): the project's connections and its task threads.
              { path: 'agents', ...secondary(async () => { const page = await import('./agents/ProjectAgents'); return { Component: page.ProjectAgents, loader: page.projectAgentsLoader }; }) },
              // An invitation's link (#62): opens the session's work with the invitation card.
              { path: 'live/:sessionId', ...secondary(async () => ({ Component: (await import('./live/LiveOpen')).LiveOpen })) },
            ],
          },
          { path: 'materials/:materialId', ...material },
          { path: 'materials/:materialId/versions/:version', ...material },
          { path: 'tasks', ...secondary(async () => ({ Component: (await import('./app/TasksView')).TasksView })) },
          { path: 'map', ...secondary(async () => ({ Component: (await import('./sketch/SketchIndex')).SketchIndex })) },
          { path: 'map/:sketchId', ...sketch },
          { path: 'docs', ...secondary(async () => ({ Component: (await import('./docs/DocViews')).WorkspaceDocs })) },
          { path: 'search', ...secondary(async () => ({ Component: (await import('./search/SearchPage')).SearchPage })) },
          { path: 'dm', ...secondary(async () => ({ Component: (await import('./dm/DmIndex')).DmIndex })) },
          { path: 'dm/new', ...secondary(async () => ({ Component: (await import('./dm/DmIndex')).NewDm })) },
          { path: 'dm/:dmId', ...secondary(async () => { const page = await import('./dm/DmConversation'); return { Component: page.DmConversation, loader: page.dmLoader }; }) },
          { path: 'dm/:dmId/sketches', ...secondary(async () => ({ Component: (await import('./dm/DmSketches')).DmSketches })) },
          { path: 'dm/:dmId/sketches/:sketchId', ...sketch },
          { path: 'inbox', ...secondary(async () => ({ Component: (await import('./notifications/InboxView')).InboxView })) },
          { path: 'inbox/:id', ...secondary(async () => ({ Component: (await import('./notifications/InboxView')).InboxOpen })) },
          // Settings (#350, F-026): every earlier address still opens its section.
          {
            path: 'settings',
            ...secondary(async () => ({ Component: (await settingsPage()).SettingsLayout })),
            children: [
              { index: true, ...secondary(async () => ({ Component: (await settingsPage()).SettingsHome })) },
              { path: 'appearance', ...secondary(async () => ({ Component: (await settingsPage()).SettingsHome })) },
              { path: 'account', ...secondary(async () => ({ Component: (await settingsPage()).SettingsAccount })) },
              { path: 'notifications', ...secondary(async () => ({ Component: (await import('./notifications/NotificationSettings')).NotificationSettings })) },
              { path: 'notifications/verify', ...secondary(async () => ({ Component: (await import('./notifications/NotificationSettings')).VerifyAddress })) },
              { path: 'agents', ...secondary(async () => ({ Component: (await settingsPage()).SettingsAgents })) },
              { path: 'shortcuts', ...secondary(async () => ({ Component: (await settingsPage()).KeyboardShortcuts })) },
              { path: 'assistant', ...secondary(async () => ({ Component: (await import('./assistant/AssistantSettings')).AssistantSettings })) },
              { path: 'background-compute', ...secondary(async () => { const page = await import('./proactive-comparison/BackgroundComputeSettings'); return { Component: page.BackgroundComputeSettings, loader: page.backgroundComputeLoader }; }) },
            ],
          },
          { path: '*', Component: NotFoundView },
        ],
      },
    ],
  },
]);
