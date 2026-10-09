import { Outlet, createBrowserRouter } from 'react-router';
import { ToastProvider } from './ui';
import { UpdatePrompt } from './pwa';
import { AppLayout } from './app/AppLayout';
import { KeyboardShortcuts, SettingsAccount, SettingsAgents, SettingsHome, SettingsLayout } from './app/SettingsHome';
import { ProjectsIndex } from './app/ProjectsIndex';
import { appLoader } from './app/data';
import { ProjectConversation, projectConversationLoader, shouldRevalidateProjectConversation } from './app/ProjectConversation';
import { ProjectSetup } from './app/ProjectSetup';
import { MaterialView, materialLoader } from './app/MaterialView';
import { ProjectTasks, projectTasksLoader } from './work/ProjectTasks';
import { ProjectAgents, projectAgentsLoader } from './agents/ProjectAgents';
import { DocHistory, DocReader, WikiHome, WorkspaceDocs, docHistoryLoader, docLoader } from './docs/DocViews';
import { DocEditor, docEditLoader } from './docs/DocEditor';
import { WikiLayout, wikiLoader, wikiShouldRevalidate } from './docs/Wiki';
import { Booting, RouteErrorPage } from './app/errors';
import { ConversationView, NotFoundView, TasksView } from './app/views';
import { DmIndex, NewDm } from './dm/DmIndex';
import { DmConversation, dmLoader } from './dm/DmConversation';
import { DmSketches } from './dm/DmSketches';
import { InboxOpen, InboxView } from './notifications/InboxView';
import { NotificationSettings, UnsubscribePage, VerifyAddress } from './notifications/NotificationSettings';
import { SketchIndex } from './sketch/SketchIndex';
import { SketchRoute } from './sketch/SketchView';
import { projectShellLoader } from './project/data';
import { ProjectMap } from './project/ProjectViews';
import { LiveOpen } from './live/LiveOpen';
import { SearchPage } from './search/SearchPage';
import { GithubSettings } from './github/GithubSettings';
import { AssistantSettings } from './assistant/AssistantSettings';
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
import { AgentConnectionPage, AgentConsentPage, agentConnectionLoader, agentConsentLoader } from './agent-connection/pages';
import { BackgroundComputeSettings, backgroundComputeLoader } from './proactive-comparison/BackgroundComputeSettings';

function Root() {
  // The update prompt is shown on every page, signed in or not; reloading is the person's choice.
  return <ToastProvider><Outlet /><UpdatePrompt /></ToastProvider>;
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
          { path: 'connect-agent', loader: agentConnectionLoader, Component: AgentConnectionPage },
          { path: 'consent', loader: agentConsentLoader, Component: AgentConsentPage },
          // Linked from notification email (#116); works without signing in.
          { path: 'unsubscribe', Component: UnsubscribePage },
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
          { path: 'projects', Component: ProjectsIndex },
          { path: 'projects/new', Component: ProjectSetup },
          {
            // One project (#117): its header, audience, state line and view tabs share this data.
            id: 'project',
            path: 'projects/:projectId',
            loader: projectShellLoader,
            children: [
              // One conversation (UI116-1): the stream stays mounted while a root's thread opens beside it.
              { loader: projectConversationLoader, shouldRevalidate: shouldRevalidateProjectConversation, Component: ProjectConversation,
                children: [{ index: true }, { path: 'conversations/:conversationId' }] },
              { path: 'github', Component: GithubSettings },
              { path: 'tasks', loader: projectTasksLoader, Component: ProjectTasks },
              { path: 'map', Component: ProjectMap },
              { path: 'map/:sketchId', Component: SketchRoute },
              {
                // The wiki (#112) as two panes (#136): the page index beside the open page.
                id: 'wiki',
                path: 'docs',
                loader: wikiLoader,
                shouldRevalidate: wikiShouldRevalidate,
                Component: WikiLayout,
                children: [
                  { index: true, Component: WikiHome },
                  { path: 'new', loader: docEditLoader, Component: DocEditor },
                  { path: ':docId', loader: docLoader, Component: DocReader },
                  { path: ':docId/versions/:version', loader: docLoader, Component: DocReader },
                  { path: ':docId/edit', loader: docEditLoader, Component: DocEditor },
                  { path: ':docId/history', loader: docHistoryLoader, Component: DocHistory },
                ],
              },
              // Agents (UI116-2, #136): the project's connections and its task threads.
              { path: 'agents', loader: projectAgentsLoader, Component: ProjectAgents },
              // An invitation's link (#62): opens the session's work with the invitation card.
              { path: 'live/:sessionId', Component: LiveOpen },
            ],
          },
          { path: 'materials/:materialId', loader: materialLoader, Component: MaterialView },
          { path: 'materials/:materialId/versions/:version', loader: materialLoader, Component: MaterialView },
          { path: 'tasks', Component: TasksView },
          { path: 'map', Component: SketchIndex },
          { path: 'map/:sketchId', Component: SketchRoute },
          { path: 'docs', Component: WorkspaceDocs },
          { path: 'search', Component: SearchPage },
          { path: 'dm', Component: DmIndex },
          { path: 'dm/new', Component: NewDm },
          { path: 'dm/:dmId', loader: dmLoader, Component: DmConversation },
          { path: 'dm/:dmId/sketches', Component: DmSketches },
          { path: 'dm/:dmId/sketches/:sketchId', Component: SketchRoute },
          { path: 'inbox', Component: InboxView },
          { path: 'inbox/:id', Component: InboxOpen },
          // Settings (#350, F-026): every earlier address still opens its section.
          {
            path: 'settings',
            Component: SettingsLayout,
            children: [
              { index: true, Component: SettingsHome },
              { path: 'appearance', Component: SettingsHome },
              { path: 'account', Component: SettingsAccount },
              { path: 'notifications', Component: NotificationSettings },
              { path: 'notifications/verify', Component: VerifyAddress },
              { path: 'agents', Component: SettingsAgents },
              { path: 'shortcuts', Component: KeyboardShortcuts },
              { path: 'assistant', Component: AssistantSettings },
              { path: 'background-compute', loader: backgroundComputeLoader, Component: BackgroundComputeSettings },
            ],
          },
          { path: '*', Component: NotFoundView },
        ],
      },
    ],
  },
]);
