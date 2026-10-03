import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { AI_PROVIDERS, aiConnectionLabel, isAiProviderKind, type AiProviderKind, type BackgroundComputeConnection, type BackgroundComputeUsage,
  type ConnectBackgroundComputeCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button } from '../ui';
import { connectBackgroundCompute, currentBackgroundUsage, listBackgroundConnections, markBackgroundConnection, revokeBackgroundConnection } from './api';
import { BackgroundUsage } from './BackgroundUsage';
import { comparisonReserveText, ConnectionFields, priceSourceText, priceText } from './ConnectionFields';
import { ProjectRuleSettings } from './ProjectRuleSettings';
import './background.css';

export async function backgroundComputeLoader({ request }: LoaderFunctionArgs) {
  const [connections, usage] = await Promise.all([listBackgroundConnections(request.signal), currentBackgroundUsage(request.signal)]);
  return { connections, usage };
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

/**
 * Owner-only AI connections (F-020 PROV-1): one or more, each with its own key, payer and allowance.
 * Background suggestions use the one the owner marks; removing it stops them, with no fallback.
 * Saving consent does not activate background execution.
 */
export function BackgroundComputeSettings() {
  const initial = useLoaderData() as { connections: BackgroundComputeConnection[]; usage: BackgroundComputeUsage };
  const [connections, setConnections] = useState(initial.connections);
  const connection = connections.find((item) => item.usedForBackground) ?? null;
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
  const addRef = useRef<HTMLButtonElement>(null);
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
  function cancelAdding() {
    formRef.current?.reset(); setEditing(false); setError('');
    requestAnimationFrame(() => addRef.current?.focus());
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
    const name = String(data.get('connectionName') ?? '').trim();
    const command: ConnectBackgroundComputeCommand = {
      ...(name ? { name } : {}), useForBackground: data.get('useForBackground') === 'on' || connections.length === 0,
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
      const added = await connectBackgroundCompute(command);
      setConnections(await listBackgroundConnections().catch(() => [added, ...connections.map((item) => (added.usedForBackground ? { ...item, usedForBackground: false } : item))]));
      setEditing(false);
      announce(added.usedForBackground ? 'Connection saved and used for background suggestions. No rule was enabled.' : 'Connection saved. No rule was enabled.');
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

  async function disconnect(target: BackgroundComputeConnection) {
    if (busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      await revokeBackgroundConnection(target.id);
      setConnections((current) => current.filter((item) => item.id !== target.id));
      announce(target.usedForBackground
        ? 'Disconnected in Flux. Background suggestions stop until you choose another connection; none takes over by itself.'
        : 'Disconnected in Flux. New requests cannot use this key.');
      await refreshUsage();
    } catch (cause) { setError(failure(cause)); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  }

  async function chooseForBackground(target: BackgroundComputeConnection) {
    if (busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const marked = await markBackgroundConnection(target.id);
      setConnections((current) => current.map((item) => (item.id === marked.id ? marked : { ...item, usedForBackground: false })));
      announce(`Background suggestions now use ${marked.name}.`);
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

    {connections.length ? <section className="background-settings__section" aria-labelledby="background-current">
      <div className="background-settings__section-head">
        <h3 id="background-current">Your AI connections</h3>
        {!editing ? <Button ref={addRef} icon="plus" disabled={busy} onClick={() => { setEditing(true); setError(''); setSaved(''); }}>Add a connection</Button> : null}
      </div>
      {error && !editing ? <p ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
      {!connection ? <p className="background-settings__note" role="note">No connection is used for background suggestions. Choose one below; Flux never picks one for you.</p> : null}
      <ul className="background-settings__connections">
        {connections.map((item) => <li key={item.id} className="background-settings__connection" aria-labelledby={`connection-${item.id}`}>
          <div className="background-settings__connection-head">
            <h4 id={`connection-${item.id}`}>{item.name}</h4>
            {item.usedForBackground ? <span className="background-settings__badge">Used for background suggestions</span> : null}
          </div>
          <dl className="background-settings__metadata">
            <div><dt>Provider / model</dt><dd>{aiConnectionLabel(item.provider, item.model)}</dd></div>
            {item.baseUrl ? <div><dt>Endpoint</dt><dd>{item.baseUrl}</dd></div> : null}
            <div><dt>Price</dt><dd>{item.price
              ? <>{priceText(item.price)} · {priceSourceText(item.price)}. One request reserves up to {comparisonReserveText(item.price)}.</>
              : 'Unknown. It cannot be used until a price is known; add the connection again with a price.'}</dd></div>
            <div><dt>Paid by</dt><dd>{item.payerOrganization} · {item.providerWorkspace}</dd></div>
            <div><dt>Key</dt><dd>Ending {item.keyLastFour}</dd></div>
            <div><dt>Local allowance</dt><dd>{money(item.periodBudgetCents)} over rolling 30 days · up to {item.maxRunsPerDay} requests a UTC day · {money(item.perRunCents)} per request</dd></div>
          </dl>
          <p className="background-settings__help">The key-owning organization pays {payee(item.provider)}. Flux limits new requests; this allowance does not guarantee the provider invoice. Interrupted requests can still be charged.</p>
          <div className="background-settings__actions">
            {!item.usedForBackground ? <Button disabled={busy} onClick={() => void chooseForBackground(item)} aria-describedby={`connection-${item.id}`}>Use for background suggestions</Button> : null}
            <Button disabled={busy} onClick={() => void disconnect(item)} aria-label={`Disconnect ${item.name}`}>Disconnect</Button>
          </div>
          <p className="background-settings__help">Disconnecting removes this key from Flux. Revoke it at {item.provider === 'openai_compatible' ? 'your endpoint' : AI_PROVIDERS[item.provider].label} too if it should stop working outside Flux.</p>
        </li>)}
      </ul>
    </section> : null}

    {!connections.length || editing ? <section ref={connectSectionRef} className="background-settings__section" aria-labelledby="background-connect">
      <div className="background-settings__section-head">
        <h3 id="background-connect">{connections.length ? 'Add a connection' : 'Connect your background source'}</h3>
      </div>
      {error ? <p id="background-connect-error" ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
      <p className="background-settings__help">Choose any supported provider and model; every one takes the same path in Flux. A named-project rule may send its published human evidence for one camera/sensor comparison. It can prepare a quiet suggestion; people choose whether to use it.</p>
      <form ref={formRef} onSubmit={(event) => void connect(event)}>
        <fieldset disabled={busy} className="background-settings__fields">
          <label>Connection name<input name="connectionName" autoComplete="off" maxLength={80} placeholder="For example: Work OpenRouter" /></label>
          <ConnectionFields connection={null} disabled={busy} onProvider={setFormProvider} />
          <label>Background API key<input name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={512}
            aria-describedby={`background-key-help${error ? ' background-connect-error' : ''}`} /></label>
          <p id="background-key-help" className="background-settings__help">{keyHelp} This field is cleared after every save attempt; enter a new key to try again.</p>
          <label>Provider organization<input name="payerOrganization" autoComplete="off" required minLength={2} maxLength={120} /></label>
          <label>Provider workspace<input name="providerWorkspace" autoComplete="off" required minLength={2} maxLength={120} /></label>
          <div className="background-settings__limits">
            <label>Maximum requests a day<input name="maxRunsPerDay" type="number" required min={1} max={3} step={1} defaultValue={1} /></label>
            <label>30-day local allowance (USD)<input name="periodBudget" type="number" required min="0.05" max="10.00" step="0.01" defaultValue="1.00" /></label>
            <label>Per-request local allowance (USD)<input name="perRun" type="number" required min="0.05" max="0.50" step="0.01" defaultValue="0.05" /></label>
          </div>
          <p className="background-settings__help">One request is limited to 8,000 input tokens, counted with the same conservative Flux estimate for every provider, and 1,200 output tokens. Before starting it, Flux reserves the most it can cost at the connection’s price, and at least $0.05. Unknown possible charges stay counted; no automatic retry or other payer is used.</p>
          <label className="background-settings__check"><input name="workspaceScoped" type="checkbox" required /><span>This key is restricted to the single provider workspace named above.</span></label>
          <label className="background-settings__check"><input name="payerAuthority" type="checkbox" required /><span>I am authorized to spend on that organization's provider account.</span></label>
          <label className="background-settings__check"><input name="providerBilling" type="checkbox" required /><span>I understand that the organization pays the AI provider and that Flux's local allowance is not an invoice cap.</span></label>
          <label className="background-settings__check"><input name="projectDisclosure" type="checkbox" required /><span>I allow human evidence published in the projects I enable to be sent to this provider; suggestions are visible to that project's readers.</span></label>
          {connections.length ? <label className="background-settings__check"><input name="useForBackground" type="checkbox" /><span>Use this connection for background suggestions instead of {connection ? connection.name : 'none'}.</span></label>
            : <p className="background-settings__help">Your first connection is used for background suggestions. You can add more and choose another later.</p>}
          <div className="background-settings__actions">
            <Button type="submit" variant="primary" busy={busy}>Save connection and consent</Button>
            {connections.length ? <Button onClick={cancelAdding}>Cancel</Button> : null}
          </div>
        </fieldset>
      </form>
    </section> : null}
    <BackgroundUsage usage={usage} busy={usageBusy} error={usageError} refresh={() => void refreshUsage()} historyRef={historyRef} />
    <ProjectRuleSettings connection={connection} />
    <Link className="background-settings__back" to="/">Continue in Flux</Link>
  </div></div>;
}
