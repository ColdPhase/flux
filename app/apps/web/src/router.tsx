import { Outlet, createBrowserRouter } from 'react-router';
import { ToastProvider } from './ui';
import { UpdatePrompt } from './pwa';
import { AppLayout } from './app/AppLayout';
import { appLoader } from './app/data';
import { ProjectConversation, projectConversationLoader } from './app/ProjectConversation';
import { ProjectSetup } from './app/ProjectSetup';
import { MaterialView, materialLoader } from './app/MaterialView';
import { ProjectTasks, projectTasksLoader } from './work/ProjectTasks';
import { DocHistory, DocReader, ProjectDocs, WorkspaceDocs, docHistoryLoader, docLoader, projectDocsLoader } from './docs/DocViews';
import { DocEditor, docEditLoader } from './docs/DocEditor';
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
          { path: 'projects/new', Component: ProjectSetup },
          {
            // One project (#117): its header, audience, state line and view tabs share this data.
            id: 'project',
            path: 'projects/:projectId',
            loader: projectShellLoader,
            children: [
              { index: true, loader: projectConversationLoader, Component: ProjectConversation },
              { path: 'conversations/:conversationId', loader: projectConversationLoader, Component: ProjectConversation },
              { path: 'github', Component: GithubSettings },
              { path: 'tasks', loader: projectTasksLoader, Component: ProjectTasks },
              { path: 'map', Component: ProjectMap },
              { path: 'map/:sketchId', Component: SketchRoute },
              { path: 'docs', loader: projectDocsLoader, Component: ProjectDocs },
              { path: 'docs/new', loader: docEditLoader, Component: DocEditor },
              { path: 'docs/:docId', loader: docLoader, Component: DocReader },
              { path: 'docs/:docId/versions/:version', loader: docLoader, Component: DocReader },
              { path: 'docs/:docId/edit', loader: docEditLoader, Component: DocEditor },
              { path: 'docs/:docId/history', loader: docHistoryLoader, Component: DocHistory },
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
          { path: 'settings/notifications', Component: NotificationSettings },
          { path: 'settings/background-compute', loader: backgroundComputeLoader, Component: BackgroundComputeSettings },
          { path: 'settings/notifications/verify', Component: VerifyAddress },
          { path: 'settings/assistant', Component: AssistantSettings },
          { path: '*', Component: NotFoundView },
        ],
      },
    ],
  },
]);
