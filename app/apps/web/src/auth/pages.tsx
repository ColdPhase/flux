import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Form, Link, Outlet, useActionData, useLoaderData, useLocation, useNavigate, useNavigation, useSearchParams } from 'react-router';
import type { IdentityCapabilities } from '@flux/contracts';
import { PASSWORD_MIN_LENGTH, claimAddress, getCapabilities, getPendingClaim, startSso } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import { Button, ErrorState, FluxLogo, Icon, Input, useToast } from '../ui';
import { safeNext, signedOauthQuery, type FormResult, type forgotPasswordLoader } from './logic';

/** The Flux logo tile and wordmark, as in the sidebar (#189, F-026 §3). */
function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Flux home">
      <FluxLogo size={28} />
      <span className="brand__name" aria-hidden="true">flux</span>
    </Link>
  );
}

/** Quiet single-column frame for signing in and account recovery. */
export function AuthLayout() {
  const location = useLocation();
  const connectionFlow = location.pathname === '/connect-agent' || location.pathname === '/consent';
  return (
    <div className="auth">
      <a className="ui-skip" href="#auth-main">Skip to content</a>
      <header className="auth__top"><Brand />
        {/* Opened from Settings rather than by an agent's sign-in: a way back (#266 PF-5). */}
        {location.pathname === '/connect-agent' && !location.search ? <Link to="/settings" className="auth__back"><Icon name="chevron-left" size={14} />Settings</Link> : null}
      </header>
      <main className="auth__main" id="auth-main" tabIndex={-1}>
        {/* Keyed by path so each page settles in when it replaces the previous one. */}
        <div className={`auth__col${connectionFlow ? ' auth__col--connection' : ''}`} key={location.pathname}>
          <Outlet />
        </div>
      </main>
      <footer className="auth__foot">Open source workspace for people and agents</footer>
    </div>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="auth__head">
      <h1 className="auth__title">{title}</h1>
      {children ? <p className="auth__lead">{children}</p> : null}
    </div>
  );
}

function FormError({ message, children }: { message?: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.focus(); }, [message]);
  if (!message) return null;
  return (
    <div className="auth__error" role="alert" tabIndex={-1} ref={ref}>
      <Icon name="alert" />
      <div><p>{message}</p>{children}</div>
    </div>
  );
}

function useSubmitting() {
  const navigation = useNavigation();
  return navigation.state === 'submitting' || (navigation.state === 'loading' && navigation.formMethod !== undefined);
}

/** Focus the first invalid field after a failed submit. */
function useFocusFirstInvalid(result: FormResult | undefined) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (result?.fieldErrors && Object.values(result.fieldErrors).some(Boolean)) {
      formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
    }
  }, [result]);
  return formRef;
}

const NOTICES: Record<string, string> = {
  'signed-out': 'You’re signed out.',
  'password-changed': 'Your password was changed. Sign in with the new one.',
  'email-verified': 'Your email address is verified. Sign in to continue.',
};

/** The operator's single sign-on, when configured (#113). Hidden while unknown or unavailable. */
function useCapabilities() {
  const [capabilities, setCapabilities] = useState<IdentityCapabilities | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getCapabilities(controller.signal).then(setCapabilities).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return capabilities;
}



function SsoSignIn({ sso, next, oauthQuery, divider = false }: { sso: NonNullable<IdentityCapabilities['sso']>; next: string | null; oauthQuery?: string; divider?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const unreachable = `${sso.label} is not reachable right now. Try again in a moment.`;
  const start = async () => {
    setBusy(true); setFailed('');
    try {
      const { url } = await startSso(sso.providerId, oauthQuery ? '/' : safeNext(next), oauthQuery);
      window.location.assign(url);
    } catch (error) {
      setBusy(false);
      setFailed(error instanceof NetworkError ? 'Flux can’t be reached right now. Check your connection and try again.' : unreachable);
    }
  };
  return (
    <div className="auth__sso">
      <Button variant="secondary" size="lg" block busy={busy} disabled={!sso.reachable} onClick={() => void start()}>{`Sign in with ${sso.label}`}</Button>
      {failed || !sso.reachable ? <p className="auth__sso-error" role="alert">{failed || unreachable}</p> : null}
      {divider ? <p className="auth__or" aria-hidden="true"><span>or</span></p> : null}
    </div>
  );
}

export function SignInPage() {
  const result = useActionData() as FormResult | undefined;
  const submitting = useSubmitting();
  const formRef = useFocusFirstInvalid(result);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const notice = params.get('notice');
  const location = useLocation();
  const next = location.pathname === '/login' ? `${location.pathname}${location.search}` : params.get('next');
  const shownRef = useRef<string | null>(null);
  const capabilities = useCapabilities();
  const sso = capabilities?.sso ?? null;
  const ssoOnly = capabilities?.ssoOnly ?? false;
  const ssoFailed = params.get('sso') === 'failed';
  const reason = params.get('sso_reason');
  const ssoMessage = reason === 'no_refresh_token'
    ? 'Your identity provider didn’t let Flux keep checking your account, so you aren’t signed in. Ask your administrator to allow offline access for Flux.'
    : reason === 'email_held'
      ? 'Single sign-on didn’t complete: your email address already belongs to another Flux account. Nothing was linked and nothing was changed. Ask your administrator to check that account.'
      : 'Single sign-on didn’t complete, so you aren’t signed in. Try again.';
  // On the MCP authorization step the page is `/login?<signed request>` (#310): the provider button carries it.
  const oauthQuery = location.pathname === '/login' ? signedOauthQuery(location.search) ?? undefined : undefined;

  // One-time notices arrive as a query flag; show them once and drop the flag from the address.
  useEffect(() => {
    if (!notice || !NOTICES[notice] || shownRef.current === notice) return;
    shownRef.current = notice;
    toast({ message: NOTICES[notice], tone: 'success' });
    const rest = new URLSearchParams(params);
    rest.delete('notice');
    navigate({ search: rest.toString() ? `?${rest}` : '' }, { replace: true });
  }, [notice, params, navigate, toast]);

  const suffix = next ? `?next=${encodeURIComponent(next)}` : '';
  // With the sole provider in SSO-only mode, single sign-on is the only way in: no password form (F-024 S5a/S5b).
  if (sso && ssoOnly) {
    return (
      <>
        <Heading title="Sign in to Flux">Pick up your work where you left it.</Heading>
        <SsoSignIn sso={sso} next={next} oauthQuery={oauthQuery} />
        <FormError message={ssoFailed ? ssoMessage : undefined} />
      </>
    );
  }
  return (
    <>
      <Heading title="Sign in to Flux">Pick up your work where you left it.</Heading>
      {sso ? <SsoSignIn sso={sso} next={next} oauthQuery={oauthQuery} divider /> : null}
      <Form method="post" className="auth__form" noValidate ref={formRef} aria-label="Sign in">
        <FormError message={result?.formError ?? (ssoFailed ? ssoMessage : undefined)} />
        <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
          defaultValue={result?.values?.email} error={result?.fieldErrors?.email} autoFocus />
        <Input label="Password" name="password" type="password" autoComplete="current-password" error={result?.fieldErrors?.password}
          labelAside={<Link className="ui-link" to="/forgot-password">Forgot password?</Link>} />
        <Button type="submit" variant="primary" size="lg" block busy={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</Button>
      </Form>
      <p className="auth__alt">New to Flux? <Link className="ui-link" to={`/sign-up${suffix}`}>Create an account</Link></p>
    </>
  );
}

export function SignUpPage() {
  const { signup } = useLoaderData() as { signup: IdentityCapabilities['signup'] };
  const result = useActionData() as FormResult | undefined;
  const submitting = useSubmitting();
  const formRef = useFocusFirstInvalid(result);
  const [params] = useSearchParams();
  const next = params.get('next');
  const suffix = next ? `?next=${encodeURIComponent(next)}` : '';
  // The length hint goes away once the password is long enough (#189), and so does the last
  // attempt's error once the password has been changed to a long enough one.
  const [passwordLength, setPasswordLength] = useState(0);
  const [editedAfter, setEditedAfter] = useState<typeof result>(undefined);
  const passwordError = editedAfter === result && passwordLength >= PASSWORD_MIN_LENGTH ? undefined : result?.fieldErrors?.password;
  if (result?.verifyEmailAt) {
    return (
      <>
        <Heading title="Check your email" />
        <div className="auth__sent" role="status">
          <p>We sent a link to <strong>{result.verifyEmailAt}</strong>. Open it to verify the address, then sign in. The link works once.</p>
          <p>Nothing arrived? Check spam. Signing in with the password sends a new link.</p>
        </div>
        <p className="auth__alt"><Link className="ui-link" to={`/sign-in${suffix}`}>Go to sign in</Link></p>
      </>
    );
  }
  if (signup === 'off') {
    return (
      <>
        <Heading title="Sign-up is closed" />
        <div className="auth__notice" role="status">
          <Icon name="alert" />
          <div>
            <p><strong>Creating an account with a password is closed on this Flux server.</strong></p>
            <p>Ask the person who runs it to add you, or sign in if you already have an account.</p>
          </div>
        </div>
        <p className="auth__alt"><Link className="ui-link" to={`/sign-in${suffix}`}>Sign in</Link></p>
      </>
    );
  }
  return (
    <>
      <Heading title="Create your Flux account">{signup === 'verified' ? 'We’ll email a link to confirm your address.' : 'One account for your conversations, work and handoffs.'}</Heading>
      <Form method="post" className="auth__form" noValidate ref={formRef} aria-label="Create account">
        <FormError message={result?.formError}>
          {result?.accountExists ? <p><Link className="ui-link" to="/sign-in">Sign in</Link> · <Link className="ui-link" to="/forgot-password">Reset password</Link></p> : null}
        </FormError>
        <Input label="Name" name="name" autoComplete="name" defaultValue={result?.values?.name} error={result?.fieldErrors?.name}
          hint="Shown to people you work with." autoFocus />
        <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
          defaultValue={result?.values?.email} error={result?.fieldErrors?.email} />
        <Input label="Password" name="password" type="password" autoComplete="new-password" error={passwordError}
          onChange={(event) => { setPasswordLength(event.target.value.length); setEditedAfter(result); }}
          hint={passwordLength >= PASSWORD_MIN_LENGTH ? undefined : `At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`} />
        <Button type="submit" variant="primary" size="lg" block busy={submitting}>{submitting ? 'Creating account…' : 'Create account'}</Button>
      </Form>
      <p className="auth__alt">Already have an account? <Link className="ui-link" to={`/sign-in${suffix}`}>Sign in</Link></p>
    </>
  );
}

/**
 * A provider sign-in found its verified email on a Flux account nobody has verified (#313). Linking comes first:
 * the person can sign in to that account. Claiming releases the address from it; its data stays with it.
 */
export function ClaimPage() {
  const [params] = useSearchParams();
  const [claim, setClaim] = useState<{ email: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const back = params.get('return') ?? '/sign-in';
  const oauthQuery = signedOauthQuery(back.includes('?') ? back.slice(back.indexOf('?')) : '') ?? undefined;
  useEffect(() => {
    const controller = new AbortController();
    getPendingClaim(controller.signal).then(setClaim).catch(() => setClaim(null));
    return () => controller.abort();
  }, []);
  const capabilities = useCapabilities();
  const sso = capabilities?.sso;
  const linkable = capabilities?.linkable === true;
  const confirm = async () => {
    if (!sso) return;
    setBusy(true); setFailed('');
    try {
      await claimAddress();
      const { url } = await startSso(sso.providerId, '/', oauthQuery);
      window.location.assign(url);
    } catch (error) {
      setBusy(false);
      setFailed(error instanceof ApiError && error.status === 409 ? 'That address now belongs to a verified or linked account, so it can’t be claimed.'
        : error instanceof NetworkError ? 'Flux can’t be reached right now. Check your connection and try again.' : 'That didn’t work. Start again from the sign-in page.');
    }
  };
  if (claim === undefined) return <Heading title="One moment" />;
  if (claim === null) {
    return (
      <ErrorState level={1} title="There is nothing to claim here"
        actions={<Link className="ui-btn ui-btn--primary ui-btn--lg" to={back}>Back to sign in</Link>}>
        <p>This page works only right after single sign-on finds your address on an unverified account, and only for 15 minutes.</p>
      </ErrorState>
    );
  }
  return (
    <>
      <Heading title="This address already has a Flux account">
        <strong>{claim.email}</strong> belongs to a Flux account whose address nobody has verified.
      </Heading>
      <div className="auth__notice" role="status">
        <Icon name="alert" />
        <div>
          {linkable ? <p><strong>Link first.</strong> If that account is yours, sign in to it and link single sign-on in Settings; it keeps everything it has.</p>
            : <p><strong>Keep your existing account.</strong> If it is yours, ask the person who runs Flux to link it to your single sign-on identity. It keeps everything it has.</p>}
          <p><strong>Or claim the address.</strong> Flux then gives it up: the old account is signed out everywhere and its agent connections stop, but its data stays with it and does not move to your new account.</p>
        </div>
      </div>
      {failed ? <FormError message={failed} /> : null}
      <div className="auth__form">
        {linkable ? <Link className="ui-btn ui-btn--primary ui-btn--lg ui-btn--block" to="/sign-in">Sign in to that account</Link> : null}
        <Button variant="secondary" size="lg" block busy={busy} disabled={!sso} onClick={() => void confirm()}>Claim this address</Button>
      </div>
      <p className="auth__alt"><Link className="ui-link" to={back}>Cancel</Link></p>
    </>
  );
}

function ResetUnavailable() {
  return (
    <div className="auth__notice" role="status">
      <Icon name="mail" />
      <div>
        <p><strong>Password reset by email isn’t set up on this Flux server.</strong></p>
        <p>Ask the person who runs it to reset your password, or to connect an email service so you can do it yourself.</p>
        <p className="auth__mono">For operators: set FLUX_SMTP_URL and FLUX_MAIL_FROM.</p>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const { passwordReset } = useLoaderData() as Awaited<ReturnType<typeof forgotPasswordLoader>>;
  const result = useActionData() as FormResult | undefined;
  const submitting = useSubmitting();
  const formRef = useFocusFirstInvalid(result);
  const unavailable = passwordReset === 'unavailable' || result?.resetUnavailable;

  if (result?.sentTo) {
    return (
      <>
        <Heading title="Check your email" />
        <div className="auth__sent" role="status">
          <p>If an account exists for <strong>{result.sentTo}</strong>, a link to choose a new password is on its way. The link works once and expires after a while.</p>
          <p>Nothing arrived? Check spam, or try again in a few minutes.</p>
        </div>
        <p className="auth__alt"><Link className="ui-link" to="/sign-in">Back to sign in</Link></p>
      </>
    );
  }

  return (
    <>
      <Heading title="Reset your password">Enter the email you use for Flux and we’ll send you a link to choose a new password.</Heading>
      {unavailable ? <ResetUnavailable /> : null}
      <Form method="post" className="auth__form" noValidate ref={formRef} aria-label="Request password reset">
        <FormError message={result?.formError} />
        <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
          defaultValue={result?.values?.email} error={result?.fieldErrors?.email} autoFocus={!unavailable} disabled={unavailable} />
        <Button type="submit" variant="primary" size="lg" block busy={submitting} disabled={unavailable}>{submitting ? 'Sending…' : 'Send reset link'}</Button>
      </Form>
      <p className="auth__alt"><Link className="ui-link" to="/sign-in">Back to sign in</Link></p>
    </>
  );
}

export function ResetPasswordPage() {
  const result = useActionData() as FormResult | undefined;
  const submitting = useSubmitting();
  const formRef = useFocusFirstInvalid(result);
  const [params] = useSearchParams();
  const token = params.get('token');
  const linkError = params.get('error');

  if (!token || linkError) {
    return (
      <ErrorState level={1} title="This reset link no longer works"
        actions={<><Link className="ui-btn ui-btn--primary ui-btn--lg" to="/forgot-password">Request a new link</Link><Link className="ui-btn ui-btn--quiet ui-btn--lg" to="/sign-in">Back to sign in</Link></>}>
        <p>Reset links work once and expire. Request a new one and use the latest email.</p>
      </ErrorState>
    );
  }

  return (
    <>
      <Heading title="Choose a new password">After this, you’ll be signed out everywhere and can sign in with the new password.</Heading>
      <Form method="post" className="auth__form" noValidate ref={formRef} aria-label="Choose a new password">
        <FormError message={result?.formError}>
          {result?.invalidToken ? <p><Link className="ui-link" to="/forgot-password">Request a new link</Link></p> : null}
        </FormError>
        <input type="hidden" name="token" value={token} />
        <Input label="New password" name="password" type="password" autoComplete="new-password" error={result?.fieldErrors?.password}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} autoFocus />
        <Input label="Repeat new password" name="confirm" type="password" autoComplete="new-password" error={result?.fieldErrors?.confirm} />
        <Button type="submit" variant="primary" size="lg" block busy={submitting}>{submitting ? 'Saving…' : 'Save new password'}</Button>
      </Form>
    </>
  );
}

/** Reached by address; the account menu signs out directly. */
export function SignOutPage() {
  const result = useActionData() as FormResult | undefined;
  const submitting = useSubmitting();
  return (
    <>
      <Heading title="Sign out of Flux?">You’ll need your email and password to sign in again on this device.</Heading>
      <Form method="post" className="auth__form" aria-label="Sign out">
        <FormError message={result?.formError} />
        <Button type="submit" variant="primary" size="lg" block busy={submitting}>{submitting ? 'Signing out…' : 'Sign out'}</Button>
      </Form>
      <p className="auth__alt"><Link className="ui-link" to="/">Stay signed in</Link></p>
    </>
  );
}
