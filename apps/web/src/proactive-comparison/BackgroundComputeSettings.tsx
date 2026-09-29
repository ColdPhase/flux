import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { BackgroundComputeConnection, ConnectBackgroundComputeCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button } from '../ui';
import { connectBackgroundCompute, currentBackgroundConnection, revokeBackgroundConnection } from './api';
import { ProjectRuleSettings } from './ProjectRuleSettings';
import './background.css';

export const backgroundComputeLoader = ({ request }: LoaderFunctionArgs) => currentBackgroundConnection(request.signal);
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const checks = ['workspaceScoped', 'payerAuthority', 'providerBilling', 'projectDisclosure'] as const;

function failure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE') return 'This server cannot store background credentials yet. Contact its operator.';
    if (error.status === 401) return 'Your session ended. Sign in again before changing the connection.';
    if (error.status === 404) return 'This connection is no longer available. Reload to see your current connection.';
    if (error.status === 400) return 'Check the key, organization, workspace, allowance and confirmations, then try again.';
  }
  return 'The connection could not be changed. Check your connection to Flux and try again.';
}

/** Owner-only payer/key setup. Saving consent does not activate background execution. */
export function BackgroundComputeSettings() {
  const initial = useLoaderData() as BackgroundComputeConnection | null;
  const [connection, setConnection] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const announce = (message: string) => {
    setSaved(message);
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!checks.every((name) => data.get(name) === 'on')) {
      setError('Confirm the payer, key scope, provider billing and project disclosure before saving.'); return;
    }
    const command: ConnectBackgroundComputeCommand = {
      apiKey: String(data.get('apiKey') ?? '').trim(),
      payerOrganization: String(data.get('payerOrganization') ?? '').trim(),
      providerWorkspace: String(data.get('providerWorkspace') ?? '').trim(),
      maxRunsPerDay: Number(data.get('maxRunsPerDay')),
      periodDays: 30,
      periodBudgetCents: Math.round(Number(data.get('periodBudget')) * 100),
      perRunCents: Math.round(Number(data.get('perRun')) * 100),
      workspaceScopedKeyConfirmed: true, payerAuthorityConfirmed: true,
      providerBillingAcknowledged: true, projectDataDisclosureAcknowledged: true,
    };
    setBusy(true); setError(''); setSaved('');
    try {
      setConnection(await connectBackgroundCompute(command)); setEditing(false);
      announce('Connection saved. No rule was enabled.');
    } catch (cause) { setError(failure(cause)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally {
      // The key exists only in this password input and the same-origin request, never app storage.
      const key = form.elements.namedItem('apiKey');
      if (key instanceof HTMLInputElement) key.value = '';
      command.apiKey = ''; data.delete('apiKey');
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection || busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      await revokeBackgroundConnection(connection.id); setConnection(null); setEditing(false);
      announce('Disconnected in Flux. New requests cannot use this key.');
    } catch (cause) { setError(failure(cause)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  }

  return <div className="pane-scroll"><div className="pane-in background-settings">
    <header className="background-settings__head">
      <h2 ref={headingRef} tabIndex={-1}>Your background suggestions</h2>
      <p>Only you can configure this connection and its allowance. Each project needs your separate rule.</p>
    </header>
    <p className="background-settings__note" role="note">Background execution is not available on this instance yet. Saving a connection does not enable a rule. You can keep working without AI.</p>
    <p ref={statusRef} className="background-settings__saved" tabIndex={-1} role="status">{saved}</p>
    {error ? <p ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}

    {connection ? <section className="background-settings__section" aria-labelledby="background-current">
      <h3 id="background-current">Your saved connection</h3>
      <dl className="background-settings__metadata">
        <div><dt>Provider / model</dt><dd>Claude Platform · {connection.model}</dd></div>
        <div><dt>Paid by</dt><dd>{connection.payerOrganization} · {connection.providerWorkspace}</dd></div>
        <div><dt>Key</dt><dd>Ending {connection.keyLastFour}</dd></div>
        <div><dt>Local allowance</dt><dd>{money(connection.periodBudgetCents)} over rolling 30 days · up to {connection.maxRunsPerDay} requests a UTC day · {money(connection.perRunCents)} per request</dd></div>
      </dl>
      <p className="background-settings__help">The key-owning organization pays Anthropic. Flux limits new requests; this allowance does not guarantee the provider invoice. Interrupted requests can still be charged.</p>
      <div className="background-settings__actions">
        <Button disabled={busy} onClick={() => { setEditing(true); setError(''); setSaved(''); }}>Replace connection</Button>
        <Button disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
      </div>
    </section> : null}

    {!connection || editing ? <section className="background-settings__section" aria-labelledby="background-connect">
      <h3 id="background-connect">{connection ? 'Replace your connection' : 'Connect your background source'}</h3>
      <p className="background-settings__help">Claude Platform · claude-sonnet-5. A named-project rule may send its published human evidence for one camera/sensor comparison. It can prepare a quiet suggestion; people choose whether to use it.</p>
      <form ref={formRef} onSubmit={(event) => void connect(event)}>
        <fieldset disabled={busy} className="background-settings__fields">
          <label>Background API key<input name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={23} maxLength={263} /></label>
          <label>Provider organization<input name="payerOrganization" autoComplete="off" required minLength={2} maxLength={120} defaultValue={connection?.payerOrganization} /></label>
          <label>Provider workspace<input name="providerWorkspace" autoComplete="off" required minLength={2} maxLength={120} defaultValue={connection?.providerWorkspace} /></label>
          <div className="background-settings__limits">
            <label>Maximum requests a day<input name="maxRunsPerDay" type="number" required min={1} max={3} step={1} defaultValue={connection?.maxRunsPerDay ?? 1} /></label>
            <label>30-day local allowance (USD)<input name="periodBudget" type="number" required min="0.05" max="10.00" step="0.01" defaultValue={((connection?.periodBudgetCents ?? 100) / 100).toFixed(2)} /></label>
            <label>Per-request local allowance (USD)<input name="perRun" type="number" required min="0.05" max="0.50" step="0.01" defaultValue={((connection?.perRunCents ?? 5) / 100).toFixed(2)} /></label>
          </div>
          <p className="background-settings__help">One request is limited to 8,000 counted input tokens and 1,200 output tokens. Flux reserves at least $0.05 before starting it. Unknown possible charges stay counted; no automatic retry or other payer is used.</p>
          <label className="background-settings__check"><input name="workspaceScoped" type="checkbox" required /><span>This key is restricted to the single provider workspace named above.</span></label>
          <label className="background-settings__check"><input name="payerAuthority" type="checkbox" required /><span>I am authorized to spend on that organization's provider account.</span></label>
          <label className="background-settings__check"><input name="providerBilling" type="checkbox" required /><span>I understand that the organization pays Anthropic and that Flux's local allowance is not an invoice cap.</span></label>
          <label className="background-settings__check"><input name="projectDisclosure" type="checkbox" required /><span>I allow human evidence published in the projects I enable to be sent to this provider; suggestions are visible to that project's readers.</span></label>
          <div className="background-settings__actions">
            <Button type="submit" variant="primary" busy={busy}>{connection ? 'Replace and save consent' : 'Save connection and consent'}</Button>
            {connection ? <Button onClick={() => { formRef.current?.reset(); setEditing(false); setError(''); }}>Cancel</Button> : null}
          </div>
        </fieldset>
      </form>
    </section> : null}
    <ProjectRuleSettings connection={connection} />
    <p className="background-settings__help">Disconnecting removes this key from Flux. Revoke it at Claude Platform too if it should stop working outside Flux.</p>
    <Link className="background-settings__back" to="/">Continue in Flux</Link>
  </div></div>;
}
