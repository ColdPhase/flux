import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  getCapabilities,
  getMe,
  requestPasswordReset,
  resetPassword,
  signIn,
  signUp,
} from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import { signOutDevice } from '../pwa';
import { forgetRecentSearches } from '../search/recent';
import { resetStream } from '../api/stream';
import { forgetThoughtDrafts } from '../sketch/createdDraft';
import { forgetComposerDrafts } from '../composer/draft';
import { forgetThoughtImages } from '../sketch/ThoughtImage';

export type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>;

export interface FormResult {
  formError?: string;
  /** The form error concerns an expired or used reset link. */
  invalidToken?: boolean;
  fieldErrors?: FieldErrors;
  values?: Record<string, string>;
  /** Password reset: the address the link was sent to. */
  sentTo?: string;
  /** Sign-up: the email already has an account. */
  accountExists?: boolean;
  /** Password reset is not configured on this server. */
  resetUnavailable?: boolean;
}

const AUTH_PATHS = ['/sign-in', '/sign-up', '/sign-out', '/forgot-password', '/reset-password'];

/**
 * The part of an MCP authorization request's address that the server signed (#310): `sig` plus the
 * parameters named by `ba_param`. Anything else on the address (an `sso=failed` return, `error`) is ours or
 * the provider's and is not part of the signature, so it must not travel with the request. Null without a
 * signature.
 */
export function signedOauthQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has('sig')) return null;
  const names = new Set(params.getAll('ba_param'));
  if (!names.size) return null;
  const signed = new URLSearchParams();
  for (const [key, value] of params) if (key === 'sig' || key === 'ba_param' || names.has(key)) signed.append(key, value);
  return signed.toString();
}

/** Only same-origin app paths may be used as a post-sign-in destination. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    if (AUTH_PATHS.some((path) => url.pathname === path)) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

// Set while this tab is signing out on purpose. The shell's loaders then see 401 before the sign-out
// redirect lands; their way back to sign-in must not remember the page that was open, or the next
// person to sign in on this device would be taken to the previous account's project.
let signingOutHere = false;

export function signInPath(next?: string) {
  const target = signingOutHere ? '/' : safeNext(next);
  return target === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(target)}`;
}

/** Human wording for identity failures. The server's codes stay out of the interface. */
export function describeAuthError(error: unknown, context: 'sign-in' | 'sign-up' | 'reset' | 'reset-request' | 'sign-out'): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached right now. Check your connection and try again.';
  if (!(error instanceof ApiError)) return 'Something unexpected went wrong. Try again in a moment.';
  if (error.status === 429) return 'Too many attempts in a short time. Wait a minute, then try again.';
  if (error.code === 'ORIGIN_REJECTED') return 'This page was opened from an address Flux doesn’t accept. Open Flux at its usual address and try again.';
  const code = error.code ?? '';
  if (context === 'sign-in' && (error.status === 401 || code === 'INVALID_EMAIL_OR_PASSWORD')) return 'That email and password don’t match an account.';
  if (context === 'sign-up' && code.startsWith('USER_ALREADY_EXISTS')) return 'An account with this email already exists. Sign in instead, or reset its password.';
  if (code === 'PASSWORD_TOO_SHORT') return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (code === 'PASSWORD_TOO_LONG') return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (code === 'INVALID_EMAIL') return 'Enter a valid email address.';
  if (context === 'reset' && (code === 'INVALID_TOKEN' || error.status === 400)) return 'This reset link has expired or was already used.';
  if (error.status >= 500) return 'Flux had a problem on the server. Your details were not saved. Try again in a moment.';
  return 'That didn’t work. Check the details and try again.';
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '');
const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function validatePassword(password: string): string | undefined {
  if (!password) return 'Enter a password.';
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  return undefined;
}

const hasErrors = (errors: FieldErrors) => Object.values(errors).some(Boolean);

/** Sign-in and sign-up are for people without a session; others go straight to their work. */
export async function redirectIfSignedIn({ request }: LoaderFunctionArgs) {
  const next = safeNext(new URL(request.url).searchParams.get('next'));
  try {
    if (await getMe(request.signal)) return redirect(next);
  } catch {
    // Offline or server trouble: show the form; submitting reports the problem.
  }
  return null;
}

export async function signInAction({ request }: ActionFunctionArgs): Promise<FormResult | Response> {
  const form = await request.formData();
  const email = text(form, 'email').trim();
  const password = text(form, 'password');
  const fieldErrors: FieldErrors = {
    email: !email ? 'Enter your email address.' : !looksLikeEmail(email) ? 'Enter a valid email address.' : undefined,
    password: !password ? 'Enter your password.' : undefined,
  };
  if (hasErrors(fieldErrors)) return { fieldErrors, values: { email } };
  try {
    const url = new URL(request.url);
    const oauthQuery = url.pathname === '/login' ? signedOauthQuery(url.search) ?? undefined : undefined;
    const result = await signIn({ email, password, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    if (oauthQuery) {
      const response = result as { url?: string; redirect_uri?: string };
      const destination = response.url ?? response.redirect_uri;
      if (!destination) return { formError: 'This authorization request no longer works. Start again in your agent client.', values: { email } };
      return redirect(destination);
    }
  } catch (error) {
    return { formError: describeAuthError(error, 'sign-in'), values: { email } };
  }
  signingOutHere = false;
  return redirect(safeNext(new URL(request.url).searchParams.get('next')));
}

export async function signUpAction({ request }: ActionFunctionArgs): Promise<FormResult | Response> {
  const form = await request.formData();
  const name = text(form, 'name').trim();
  const email = text(form, 'email').trim();
  const password = text(form, 'password');
  const fieldErrors: FieldErrors = {
    name: !name ? 'Enter the name people will see.' : name.length > 80 ? 'Use at most 80 characters.' : undefined,
    email: !email ? 'Enter your email address.' : !looksLikeEmail(email) ? 'Enter a valid email address.' : undefined,
    password: validatePassword(password),
  };
  if (hasErrors(fieldErrors)) return { fieldErrors, values: { name, email } };
  try {
    await signUp({ name, email, password });
  } catch (error) {
    const accountExists = error instanceof ApiError && (error.code ?? '').startsWith('USER_ALREADY_EXISTS');
    return { formError: describeAuthError(error, 'sign-up'), accountExists, values: { name, email } };
  }
  signingOutHere = false;
  return redirect(safeNext(new URL(request.url).searchParams.get('next')));
}

export async function forgotPasswordLoader({ request }: LoaderFunctionArgs) {
  try {
    const capabilities = await getCapabilities(request.signal);
    return { passwordReset: capabilities.passwordReset };
  } catch {
    return { passwordReset: 'unknown' as const };
  }
}

export async function forgotPasswordAction({ request }: ActionFunctionArgs): Promise<FormResult> {
  const form = await request.formData();
  const email = text(form, 'email').trim();
  if (!email || !looksLikeEmail(email)) return { fieldErrors: { email: email ? 'Enter a valid email address.' : 'Enter your email address.' }, values: { email } };
  try {
    await requestPasswordReset(email);
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) return { resetUnavailable: true, values: { email } };
    return { formError: describeAuthError(error, 'reset-request'), values: { email } };
  }
  return { sentTo: email };
}

export async function resetPasswordAction({ request }: ActionFunctionArgs): Promise<FormResult | Response> {
  const form = await request.formData();
  const token = text(form, 'token');
  const password = text(form, 'password');
  const confirm = text(form, 'confirm');
  const fieldErrors: FieldErrors = {
    password: validatePassword(password),
    confirm: !confirm ? 'Enter the new password again.' : confirm !== password ? 'The two passwords don’t match.' : undefined,
  };
  if (hasErrors(fieldErrors)) return { fieldErrors };
  if (!token) return { formError: 'This reset link is incomplete. Request a new one.', invalidToken: true };
  try {
    await resetPassword(token, password);
  } catch (error) {
    const message = describeAuthError(error, 'reset');
    return { formError: message, invalidToken: error instanceof ApiError && error.status === 400 };
  }
  return redirect('/sign-in?notice=password-changed');
}

export async function signOutLoader({ request }: LoaderFunctionArgs) {
  try {
    if (!(await getMe(request.signal))) return redirect('/sign-in');
  } catch {
    // Let the page render; the action reports the failure.
  }
  return null;
}

/** Signs this device out; its push subscription is removed first (#41). */
export async function signOutAction(): Promise<FormResult | Response> {
  signingOutHere = true;
  try {
    await signOutDevice();
  } catch (error) {
    signingOutHere = false;
    // fetch rejects with a TypeError when the server can't be reached.
    return { formError: describeAuthError(error instanceof TypeError ? new NetworkError() : error, 'sign-out') };
  }
  // The event stream's cursor belongs to this account; the next one in this tab starts fresh.
  resetStream();
  // Recent searches are per account and never outlive the session in this browser (#114).
  forgetRecentSearches();
  forgetThoughtDrafts();
  forgetComposerDrafts();
  forgetThoughtImages();
  return redirect('/sign-in?notice=signed-out');
}
