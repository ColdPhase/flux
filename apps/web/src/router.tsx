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
import { SketchIndex } from './sketch/SketchIndex';
import { SketchRoute } from './sketch/SketchView';
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
          { path: 'sign-in', loader: redirectIfSignedIn, action: signInAction, Component: SignInPage },
          { path: 'sign-up', loader: redirectIfSignedIn, action: signUpAction, Component: SignUpPage },
          { path: 'forgot-password', loader: forgotPasswordLoader, action: forgotPasswordAction, Component: ForgotPasswordPage },
          { path: 'reset-password', action: resetPasswordAction, Component: ResetPasswordPage },
          { path: 'sign-out', loader: signOutLoader, action: signOutAction, Component: SignOutPage },
          { path: 'connect-agent', loader: agentConnectionLoader, Component: AgentConnectionPage },
          { path: 'consent', loader: agentConsentLoader, Component: AgentConsentPage },
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
          { path: 'projects/:projectId', loader: projectConversationLoader, Component: ProjectConversation },
          { path: 'projects/:projectId/conversations/:conversationId', loader: projectConversationLoader, Component: ProjectConversation },
          { path: 'projects/:projectId/tasks', loader: projectTasksLoader, Component: ProjectTasks },
          { path: 'projects/:projectId/docs', loader: projectDocsLoader, Component: ProjectDocs },
          { path: 'projects/:projectId/docs/new', loader: docEditLoader, Component: DocEditor },
          { path: 'projects/:projectId/docs/:docId', loader: docLoader, Component: DocReader },
          { path: 'projects/:projectId/docs/:docId/versions/:version', loader: docLoader, Component: DocReader },
          { path: 'projects/:projectId/docs/:docId/edit', loader: docEditLoader, Component: DocEditor },
          { path: 'projects/:projectId/docs/:docId/history', loader: docHistoryLoader, Component: DocHistory },
          { path: 'materials/:materialId', loader: materialLoader, Component: MaterialView },
          { path: 'materials/:materialId/versions/:version', loader: materialLoader, Component: MaterialView },
          { path: 'tasks', Component: TasksView },
          { path: 'map', Component: SketchIndex },
          { path: 'map/:sketchId', Component: SketchRoute },
          { path: 'docs', Component: WorkspaceDocs },
          { path: 'dm', Component: DmIndex },
          { path: 'dm/new', Component: NewDm },
          { path: 'dm/:dmId', loader: dmLoader, Component: DmConversation },
          { path: '*', Component: NotFoundView },
        ],
      },
    ],
  },
]);
