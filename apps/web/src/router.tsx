import { Outlet, createBrowserRouter } from 'react-router';
import { ToastProvider } from './ui';
import { UpdatePrompt } from './pwa';
import { AppLayout } from './app/AppLayout';
import { appLoader } from './app/data';
import { Booting, RouteErrorPage } from './app/errors';
import { ConversationView, DirectMessagesView, DocsView, MapView, NotFoundView, TasksView } from './app/views';
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
          { path: 'tasks', Component: TasksView },
          { path: 'map', Component: MapView },
          { path: 'docs', Component: DocsView },
          { path: 'dm', Component: DirectMessagesView },
          { path: '*', Component: NotFoundView },
        ],
      },
    ],
  },
]);
