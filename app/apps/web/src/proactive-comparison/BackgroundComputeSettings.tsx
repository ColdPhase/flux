import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { AI_PROVIDERS, aiConnectionLabel, isAiProviderKind, type AiProviderKind, type BackgroundComputeConnection, type BackgroundComputeUsage,
  type ConnectBackgroundComputeCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button } from '../ui';
import { connectBackgroundCompute, currentBackgroundConnection, currentBackgroundUsage, revokeBackgroundConnection } from './api';
import { BackgroundUsage } from './BackgroundUsage';
import { comparisonReserveText, ConnectionFields, priceSourceText, priceText } from './ConnectionFields';
import { ProjectRuleSettings } from './ProjectRuleSettings';
import './background.css';

export async function backgroundComputeLoader({ request }: LoaderFunctionArgs) {
  const [connection, usage] = await Promise.all([currentBackgroundConnection(request.signal), currentBackgroundUsage(request.signal)]);
  return { connection, usage };
}
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const checks = ['workspaceScoped', 'payerAuthority', 'providerBilling', 'projectDisclosure'] as const;
/** Who is paid for the requests: the named provider, or whoever runs an owner-set endpoint. */
const payee = (provider: AiProviderKind) => (provider === 'openai_compatible' ? 'the endpoint’s operator' : AI_PROVIDERS[provider].label);
/** USD per 1M tokens typed by the owner, in micro-dollars; null when left empty. */
function ownerPrice(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000) : NaN;
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE') return 'This server cannot store background credentials yet. Contact its operator.';
    // Provider, model, endpoint and price refusals carry a safe, specific reason.
    if (error.status === 400 && error.code?.startsWith('AI_')) return `${error.message.replace(/\.$/, '')}. The key was cleared; enter it again.`;
    if (error.status === 401) return 'Your session ended. Sign in again before changing the connection.';
    if (error.status === 404) return 'This connection is no longer available. Reload to see your current connection.';
    if (error.status === 400) return 'Flux could not accept these values. The key was cleared; enter it again, then check the organization, workspace, allowance and confirmations.';
  }
  return 'The connection could not be changed. Check your connection to Flux and try again.';
}

/** Owner-only payer/key setup. Saving consent does not activate background execution. */
export function BackgroundComputeSettings() {
  const initial = useLoaderData() as { connection: BackgroundComputeConnection | null; usage: BackgroundComputeUsage };
  const [connection, setConnection] = useState(initial.connection);
  const [usage, setUsage] = useState(initial.usage);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Only to word the key help for the provider chosen in the form.
  const [formProvider, setFormProvider] = useState<AiProviderKind | ''>('');
  const keyHelp = formProvider ? AI_PROVIDERS[formProvider].keyHint : 'Choose a provider first to see what its keys look like.';
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyRef = useRef<HTMLDetailsElement>(null);
  const connectSectionRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  useLayoutEffect(() => {
    if (!editing) return;
    formRef.current?.querySelector<HTMLInputElement>('input[name="apiKey"]')?.focus({ preventScroll: true });
    connectSectionRef.current?.scrollIntoView({ block: 'start' });
  }, [editing]);
  async function refreshUsage() {
    setUsageBusy(true); setUsageError('');
    try { setUsage(await currentBackgroundUsage()); }
    catch { setUsageError('Usage could not be refreshed. The figures above are from the last update.'); }
    finally { setUsageBusy(false); }
  }
  const announce = (message: string) => {
    setSaved(message);
    requestAnimationFrame(() => statusRef.current?.focus());
  };
  function cancelReplacement() {
    formRef.current?.reset(); setEditing(false); setError('');
    requestAnimationFrame(() => replaceRef.current?.focus());
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!checks.every((name) => data.get(name) === 'on')) {
      setError('Confirm the payer, key scope, provider billing and project disclosure before saving.'); return;
    }
    const provider = String(data.get('provider') ?? '');
    if (!isAiProviderKind(provider)) { setError('Choose a provider before saving.'); return; }
    const input = ownerPrice(data.get('inputPrice'));
    const output = ownerPrice(data.get('outputPrice'));
    if (Number.isNaN(input) || Number.isNaN(output) || (input === null) !== (output === null)) {
      setError('Enter both prices as numbers of US dollars per 1M tokens, or leave both empty.'); return;
    }
    const command: ConnectBackgroundComputeCommand = {
      provider, model: String(data.get('model') ?? '').trim(),
      ...(provider === 'openai_compatible' ? { baseUrl: String(data.get('baseUrl') ?? '').trim() } : {}),
      ...(input !== null && output !== null ? { price: { inputMicrosPerMTok: input, outputMicrosPerMTok: output } } : {}),
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
      await refreshUsage();
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
      await refreshUsage();
    } catch (cause) { setError(failure(cause)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  }

  return <div className="pane-scroll"><div className="pane-in background-settings">
    <header className="background-settings__head">
      <h2 ref={headingRef} tabIndex={-1}>Your background suggestions</h2>
      <p>Only you can configure this connection and its allowance. Each project needs your separate rule.</p>
      <Button variant="link" className="background-settings__history-shortcut" onClick={() => {
        const history = historyRef.current;
        if (!history) return;
        history.open = true;
        const summary = history.querySelector('summary');
        summary?.focus({ preventScroll: true });
        summary?.scrollIntoView({ block: 'start' });
      }}>View recent requests</Button>
    </header>
    <p className="background-settings__note" role="note">Background execution is not available on this instance yet. Saving a connection does not enable a rule. You can keep working without AI.</p>
    <p ref={statusRef} className="background-settings__saved" tabIndex={-1} role="status">{saved}</p>

    {connection ? <section className="background-settings__section" aria-labelledby="background-current">
      <h3 id="background-current">Your saved connection</h3>
      <dl className="background-settings__metadata">
        <div><dt>Provider / model</dt><dd>{aiConnectionLabel(connection.provider, connection.model)}</dd></div>
        {connection.baseUrl ? <div><dt>Endpoint</dt><dd>{connection.baseUrl}</dd></div> : null}
        <div><dt>Price</dt><dd>{connection.price
          ? <>{priceText(connection.price)} · {priceSourceText(connection.price)}. One request reserves up to {comparisonReserveText(connection.price)}.</>
          : 'Unknown. No rule can be enabled until a price is known; replace the connection to enter one.'}</dd></div>
        <div><dt>Paid by</dt><dd>{connection.payerOrganization} · {connection.providerWorkspace}</dd></div>
        <div><dt>Key</dt><dd>Ending {connection.keyLastFour}</dd></div>
        <div><dt>Local allowance</dt><dd>{money(connection.periodBudgetCents)} over rolling 30 days · up to {connection.maxRunsPerDay} requests a UTC day · {money(connection.perRunCents)} per request</dd></div>
      </dl>
      <p className="background-settings__help">The key-owning organization pays {payee(connection.provider)}. Flux limits new requests; this allowance does not guarantee the provider invoice. Interrupted requests can still be charged.</p>
      {error && !editing ? <p ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
      <div className="background-settings__actions">
        <Button ref={replaceRef} disabled={busy} onClick={() => { setEditing(true); setError(''); setSaved(''); }}>Replace connection</Button>
        <Button disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
      </div>
      <p className="background-settings__help">Disconnecting removes this key from Flux. Revoke it at {connection.provider === 'openai_compatible' ? 'your endpoint' : AI_PROVIDERS[connection.provider].label} too if it should stop working outside Flux.</p>
    </section> : null}

    {!connection || editing ? <section ref={connectSectionRef} className="background-settings__section" aria-labelledby="background-connect">
      <div className="background-settings__section-head">
        <h3 id="background-connect">{connection ? 'Replace your connection' : 'Connect your background source'}</h3>
        {connection ? <Button disabled={busy} onClick={cancelReplacement}>Cancel replacement</Button> : null}
      </div>
      {error ? <p id="background-connect-error" ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
      <p className="background-settings__help">Choose any supported provider and model; every one takes the same path in Flux. A named-project rule may send its published human evidence for one camera/sensor comparison. It can prepare a quiet suggestion; people choose whether to use it.</p>
      <form ref={formRef} onSubmit={(event) => void connect(event)}>
        <fieldset disabled={busy} className="background-settings__fields">
          <ConnectionFields connection={connection} disabled={busy} onProvider={setFormProvider} />
          <label>Background API key<input name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={512}
            aria-describedby={`background-key-help${error ? ' background-connect-error' : ''}`} /></label>
          <p id="background-key-help" className="background-settings__help">{keyHelp} This field is cleared after every save attempt; enter a new key to try again.</p>
          <label>Provider organization<input name="payerOrganization" autoComplete="off" required minLength={2} maxLength={120} defaultValue={connection?.payerOrganization} /></label>
          <label>Provider workspace<input name="providerWorkspace" autoComplete="off" required minLength={2} maxLength={120} defaultValue={connection?.providerWorkspace} /></label>
          <div className="background-settings__limits">
            <label>Maximum requests a day<input name="maxRunsPerDay" type="number" required min={1} max={3} step={1} defaultValue={connection?.maxRunsPerDay ?? 1} /></label>
            <label>30-day local allowance (USD)<input name="periodBudget" type="number" required min="0.05" max="10.00" step="0.01" defaultValue={((connection?.periodBudgetCents ?? 100) / 100).toFixed(2)} /></label>
            <label>Per-request local allowance (USD)<input name="perRun" type="number" required min="0.05" max="0.50" step="0.01" defaultValue={((connection?.perRunCents ?? 5) / 100).toFixed(2)} /></label>
          </div>
          <p className="background-settings__help">One request is limited to 8,000 input tokens, counted with the same conservative Flux estimate for every provider, and 1,200 output tokens. Before starting it, Flux reserves the most it can cost at the connection’s price, and at least $0.05. Unknown possible charges stay counted; no automatic retry or other payer is used.</p>
          <label className="background-settings__check"><input name="workspaceScoped" type="checkbox" required /><span>This key is restricted to the single provider workspace named above.</span></label>
          <label className="background-settings__check"><input name="payerAuthority" type="checkbox" required /><span>I am authorized to spend on that organization's provider account.</span></label>
          <label className="background-settings__check"><input name="providerBilling" type="checkbox" required /><span>I understand that the organization pays the AI provider and that Flux's local allowance is not an invoice cap.</span></label>
          <label className="background-settings__check"><input name="projectDisclosure" type="checkbox" required /><span>I allow human evidence published in the projects I enable to be sent to this provider; suggestions are visible to that project's readers.</span></label>
          <div className="background-settings__actions">
            <Button type="submit" variant="primary" busy={busy}>{connection ? 'Replace and save consent' : 'Save connection and consent'}</Button>
            {connection ? <Button onClick={cancelReplacement}>Cancel</Button> : null}
          </div>
        </fieldset>
      </form>
    </section> : null}
    <BackgroundUsage usage={usage} busy={usageBusy} error={usageError} refresh={() => void refreshUsage()} historyRef={historyRef} />
    <ProjectRuleSettings connection={connection} />
    {!connection ? <p className="background-settings__help">Disconnecting removes this key from Flux. Revoke it at the provider too if it should stop working outside Flux.</p> : null}
    <Link className="background-settings__back" to="/">Continue in Flux</Link>
  </div></div>;
}
