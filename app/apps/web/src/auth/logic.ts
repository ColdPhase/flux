import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import type { IdentityCapabilities } from '@flux/contracts';
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
import { ApiError, NetworkError, forgetKeptReads } from '../api/client';
import { previewInvite } from '../people/api';
import { forgetLinkToken, keptLinkToken, takeLinkToken } from './linkTokens';
import { signOutDevice } from '../pwa';
import { forgetRecentPlaces } from '../search/recent';
import { forgetLastSpace } from '../app/lastSpace';
import { resetStream } from '../api/stream';
import { forgetThoughtDrafts } from '../sketch/createdDraft';
import { forgetComposerDrafts } from '../composer/retirement';
import { forgetBrowserDrafts } from '../drafts/store';
import { forgetPlaces } from '../place/memory';
import { forgetDocumentDrafts } from '../docs/drafts';
import { forgetThoughtImages } from '../sketch/ThoughtImage';
import { pacedShellRead } from '../app/shellPace';
import { forgetKeptPages } from '../app/keepPage';

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
  /** Sign-up on an invite link's page (#1438): the account exists and is signed in; the page joins now. */
  created?: boolean;
  /** Password reset is not configured on this server. */
  resetUnavailable?: boolean;
}

const AUTH_PATHS = ['/sign-in', '/sign-up', '/setup', '/sign-out', '/forgot-password', '/reset-password', '/claim'];

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

/**
 * The address the server accepts (its public origin, named in the 403 ORIGIN_REJECTED body), when it is not the one this page is on:
 * the old loopback address of a server that has moved to its public one (#1471). Null when the body names none or it is this page's own.
 */
function acceptedAddress(body: unknown): string | null {
  const named = (body as { origin?: unknown } | null)?.origin;
  if (typeof named !== 'string') return null;
  try {
    const url = new URL(named);
    return /^https?:$/.test(url.protocol) && url.origin !== window.location.origin ? url.origin : null;
  } catch { return null; }
}

/** Human wording for identity failures. The server's codes stay out of the interface. */
export function describeAuthError(error: unknown, context: 'sign-in' | 'sign-up' | 'reset' | 'reset-request' | 'sign-out'): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached right now. Check your connection and try again.';
  if (!(error instanceof ApiError)) return 'Something unexpected went wrong. Try again in a moment.';
  // The account's own back-off (#990) asks to wait a few minutes and does not say which; the other limit is per address and clears in a minute.
  if (error.code === 'SIGN_IN_THROTTLED' && error.message) return `${error.message}. If you have forgotten the password, you can reset it.`;
  if (error.status === 429) return 'Too many attempts in a short time. Wait a minute, then try again.';
  if (error.code === 'ORIGIN_REJECTED') return `This page was opened from an address Flux doesn’t accept. Open Flux at ${acceptedAddress(error.body) ?? 'its usual address'} and try again.`;
  const code = error.code ?? '';
  if (context === 'sign-in' && (error.status === 401 || code === 'INVALID_EMAIL_OR_PASSWORD')) return 'That email and password don’t match an account.';
  if (code === 'SSO_ONLY') return 'Password sign-in is closed on this Flux server. Sign in with single sign-on.';
  if (code === 'SIGNUP_CLOSED') return 'Creating an account with a password is closed on this Flux server. Ask the person who runs it.';
  if (code === 'SIGNUP_NEEDS_LINK') return 'Accounts on this Flux are made from an invite link. Ask an owner or admin of your company for one.';
  if (code === 'SETUP_DONE') return 'This Flux is already set up. Sign in, or ask for an invite link.';
  if (code === 'SETUP_LINK_INVALID' || code === 'SETUP_LINK_MISSING') return 'This setup link doesn’t work. Open the whole link that ./flux up printed on the server.';
  if (code === 'INVITE_WRONG_ACCOUNT') return 'This invite link is for a different email address.';
  if (code === 'INVITE_USED') return 'This invite link was already used. Ask whoever sent it for a new one.';
  if (code === 'INVITE_EXPIRED') return 'This invite link has expired. Ask whoever sent it for a new one.';
  if (code === 'INVITE_REVOKED' || code === 'INVITE_NOT_FOUND') return 'This invite link no longer works. Ask whoever sent it for a new one.';
  if (context === 'sign-in' && code === 'EMAIL_NOT_VERIFIED') return 'Verify your email address first. We sent a link to it; it works once.';
  if (context === 'sign-up' && code.startsWith('USER_ALREADY_EXISTS')) return 'An account with this email already exists. Sign in instead, or reset its password.';
  if (code === 'PASSWORD_TOO_WEAK' && error.message) return error.message;
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
    // Paced with the shell's own reads (#1126): a sign-in page and the app sending each other back and forth cannot loop on it.
    if (await pacedShellRead(request.signal, () => getMe(request.signal))) return redirect(next);
  } catch {
    // Offline or server trouble: show the form; submitting reports the problem.
  }
  return null;
}

/**
 * What a sign-in or sign-out page learns before it shows (#847): the server's capabilities, or null when they cannot be read (offline:
 * the page is the password page it always was). With single sign-on as the only way in, nothing else may show first.
 */
async function capabilitiesOrNull(signal: AbortSignal): Promise<IdentityCapabilities | null> {
  try { return await getCapabilities(signal); } catch { return null; }
}

/** `/sign-in`: the capabilities are read beside the session, so the page's first frame is the right one. A Flux with no company opens Setup (#1471). */
export async function signInLoader(args: LoaderFunctionArgs) {
  const capabilities = capabilitiesOrNull(args.request.signal);
  const redirectTo = await redirectIfSignedIn(args);
  if (redirectTo) return redirectTo;
  const known = await capabilities;
  if (known?.setup) return redirect('/setup');
  return { capabilities: known };
}

/** `/login`, the MCP authorization step: the same page, with no session check of its own. */
export async function loginLoader({ request }: LoaderFunctionArgs) {
  return { capabilities: await capabilitiesOrNull(request.signal) };
}

/**
 * What the sign-up form is for (#1471): `setup`, the owner's account from the setup link; `invite`, an account from the invite link this
 * tab opened (its locked address filled in); `open`, a test deployment's form without a link; `closed`, no form (ask for an invite link);
 * `set-up`, the setup link of a Flux that already has its company; `no-setup-link`, Setup opened without its token.
 */
export type SignUpMode =
  | { kind: 'setup'; token: string }
  | { kind: 'invite'; token: string; email: string | null; company: string }
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'set-up' }
  | { kind: 'no-setup-link' };

export async function setupLoader(args: LoaderFunctionArgs): Promise<Response | { mode: SignUpMode }> {
  const token = takeLinkToken('setup');
  const redirectTo = await redirectIfSignedIn(args);
  if (redirectTo) return redirectTo;
  const capabilities = await capabilitiesOrNull(args.request.signal);
  if (capabilities && !capabilities.setup) { forgetLinkToken('setup'); return { mode: { kind: 'set-up' } }; }
  return { mode: token ? { kind: 'setup', token } : { kind: 'no-setup-link' } };
}

export async function signUpLoader(args: LoaderFunctionArgs): Promise<Response | { mode: SignUpMode }> {
  const redirectTo = await redirectIfSignedIn(args);
  if (redirectTo) return redirectTo;
  const capabilities = await capabilitiesOrNull(args.request.signal);
  if (capabilities?.setup) return redirect('/setup');
  const invite = keptLinkToken('invite');
  if (invite) {
    try {
      const preview = await previewInvite(invite, args.request.signal);
      if (preview.state === 'pending') return { mode: { kind: 'invite', token: invite, email: preview.email, company: preview.workspaceName } };
    } catch {
      // A link that stopped working: the join page says why when it is opened again.
    }
  }
  return { mode: capabilities?.signup === 'open' ? { kind: 'open' } : { kind: 'closed' } };
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
  // The owner's account from the setup link (#1471) goes on to Settings › Company, to name the company and invite people.
  const owner = new URL(request.url).pathname === '/setup';
  return await signUpFrom(request) ?? redirect(owner ? '/settings/company' : safeNext(new URL(request.url).searchParams.get('next')));
}

/**
 * The create-account form on an invite link's page (founder decision 2026-11-13, #1438): the same sign-up, and the page then joins through
 * the link with the new session (`created`), so the account can only join the company the link is for.
 */
export async function joinSignUpAction({ request }: ActionFunctionArgs): Promise<FormResult> {
  return await signUpFrom(request) ?? { created: true };
}

/** Creates the account from the form; null when it is made and signed in, else what the form shows. */
async function signUpFrom(request: Request): Promise<FormResult | null> {
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
  const setupToken = text(form, 'setupToken') || undefined;
  const inviteToken = text(form, 'inviteToken') || undefined;
  try {
    await signUp({ name, email, password, ...(setupToken ? { setupToken } : {}), ...(inviteToken ? { inviteToken } : {}) });
  } catch (error) {
    const accountExists = error instanceof ApiError && (error.code ?? '').startsWith('USER_ALREADY_EXISTS');
    return { formError: describeAuthError(error, 'sign-up'), accountExists, values: { name, email } };
  }
  signingOutHere = false;
  if (setupToken) forgetLinkToken('setup');
  return null;
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
    return { formError: message, invalidToken: error instanceof ApiError && error.code === 'INVALID_TOKEN' };
  }
  return redirect('/sign-in?notice=password-changed');
}

export async function signOutLoader({ request }: LoaderFunctionArgs) {
  // The page says how the person signs in again, which depends on the server's mode (#847).
  const capabilities = capabilitiesOrNull(request.signal);
  try {
    if (!(await getMe(request.signal))) return redirect('/sign-in');
  } catch {
    // Let the page render; the action reports the failure.
  }
  return { capabilities: await capabilities };
}

/** Signs this device out; its push subscription is removed first (#41). */
export async function signOutAction({ request }: ActionFunctionArgs): Promise<FormResult | Response> {
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
  // Recent places are per account and never outlive the session in this browser (#114).
  forgetRecentPlaces();
  forgetLastSpace();
  forgetThoughtDrafts();
  forgetComposerDrafts();
  forgetBrowserDrafts();
  forgetDocumentDrafts();
  forgetKeptReads();
  forgetKeptPages();
  forgetThoughtImages();
  forgetPlaces();
  // The invite page signs a wrong account out and opens itself again, signed out, with the link this tab still holds (#1424).
  if ((await request.formData().catch(() => null))?.get('next') === '/join') return redirect('/join');
  return redirect('/sign-in?notice=signed-out');
}
