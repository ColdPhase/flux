import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import { AI_PROVIDERS, aiConnectionLabel, API_KEY_DAILY_BUDGET_CENTS, type BackgroundComputeConnection } from '@flux/contracts';
import { keyUsageLine } from '../ai/connections';
import { ApiError } from '../api/client';
import { refreshAssistantModel } from '../assistant/model';
import { Button } from '../ui';
import { listBackgroundConnections, revokeBackgroundConnection, updateBackgroundConnection } from './api';
import { AddKeyForm, BUDGET_PROBLEM, budgetCents, keyFailure, money, type AddKeyFormHandle } from './AddKeyForm';
import { priceSourceText, priceText } from './ConnectionFields';
import './background.css';

/** Settings → AI → Your API keys: the owner's own keys, each with its one daily budget, and the form to add one. */
export async function aiConnectionsLoader({ request }: LoaderFunctionArgs) {
  return { connections: await listBackgroundConnections(request.signal) };
}
/**
 * Owner-only API keys (F-020 PROV-1, Connect AI #854): one or more, each with its own key and one daily budget, the only
 * limit on what runs on it. Removing a key stops what uses it, with no fallback.
 */
export function AiConnectionsSettings() {
  const initial = useLoaderData() as { connections: BackgroundComputeConnection[] };
  return <AiConnectionsPage initial={initial} />;
}

function AiConnectionsPage({ initial }: { initial: { connections: BackgroundComputeConnection[] } }) {
  const [params] = useSearchParams();
  const revalidator = useRevalidator();
  const [connections, setConnections] = useState(initial.connections);
  // Connect AI's "API key" choice opens the form at once (#854).
  const [editing, setEditing] = useState(params.get('new') === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const formRef = useRef<AddKeyFormHandle>(null);
  const connectSectionRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Focus moves once the element it names is committed (#271). A requestAnimationFrame callback
  // can run before React renders the new error or the restored button, and then focuses nothing.
  const focusAfterRender = useRef<'status' | 'error' | 'add' | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    const node = target === 'status' ? statusRef.current : target === 'error' ? errorRef.current : target === 'add' ? addRef.current : null;
    if (!node) return;
    focusAfterRender.current = null;
    node.focus();
  });
  useLayoutEffect(() => {
    if (!editing) return;
    formRef.current?.focusFirst();
    connectSectionRef.current?.scrollIntoView({ block: 'start' });
  }, [editing]);
  // "Change" on a key in Connect AI leads here with the key named: its row comes into view.
  const shown = params.get('key');
  useLayoutEffect(() => {
    if (shown) document.getElementById(`connection-${shown}`)?.scrollIntoView({ block: 'start' });
  }, [shown]);
  const announce = (message: string) => {
    setSaved(message);
    focusAfterRender.current = 'status';
  };
  function cancelAdding() {
    formRef.current?.reset(); setEditing(false);
    focusAfterRender.current = 'add';
  }

  async function changeBudget(target: BackgroundComputeConnection, value: FormDataEntryValue | null) {
    if (busy) return;
    const budget = budgetCents(value);
    if (budget === null) { setError(BUDGET_PROBLEM); focusAfterRender.current = 'error'; return; }
    setBusy(true); setError(''); setSaved('');
    try {
      const changed = await updateBackgroundConnection(target.id, { dailyBudgetCents: budget });
      setConnections((current) => current.map((item) => (item.id === changed.id ? changed : item)));
      announce(`${changed.name}: daily budget ${money(changed.dailyBudgetCents)}.`);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'AI_BUDGET_TOO_SMALL' ? `${cause.message}.` : keyFailure(cause));
      focusAfterRender.current = 'error';
    }
    finally { setBusy(false); }
  }

  async function disconnect(target: BackgroundComputeConnection) {
    if (busy) return;
    setBusy(true); setError(''); setSaved('');
    try {
      await revokeBackgroundConnection(target.id);
      setConnections((current) => current.filter((item) => item.id !== target.id));
      announce('Removed from Flux. What used this key waits until you pick another model; nothing switches by itself.');
    } catch (cause) { setError(keyFailure(cause)); focusAfterRender.current = 'error'; }
    finally { setBusy(false); }
  }

  return <div className="pane-scroll"><div className="pane-in sset-in background-settings">
    <header className="background-settings__head">
      <h2>Your API keys</h2>
      <p>Your own keys from AI providers. Each has one daily budget, the only limit on what runs on it. Only you can see or change them.</p>
    </header>
    <p ref={statusRef} className="background-settings__saved" tabIndex={-1} role="status">{saved}</p>
    {connections.length ? <section className="background-settings__section" aria-labelledby="background-current">
      <div className="background-settings__section-head">
        <h3 id="background-current">Keys</h3>
        {!editing ? <Button ref={addRef} icon="plus" disabled={busy} onClick={() => { setEditing(true); setError(''); setSaved(''); }}>Add a key</Button> : null}
      </div>
      {error ? <p ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
      <ul className="background-settings__connections">
        {connections.map((item) => <li key={item.id} id={`connection-${item.id}`} className="background-settings__connection" aria-labelledby={`connection-${item.id}-name`}>
          <div className="background-settings__connection-head">
            <h4 id={`connection-${item.id}-name`}>{item.name}</h4>
          </div>
          <p className="background-settings__usage" data-testid="key-usage">{keyUsageLine(item)}</p>
          <dl className="background-settings__metadata">
            <div><dt>Provider / model</dt><dd>{aiConnectionLabel(item.provider, item.model)}</dd></div>
            {item.baseUrl ? <div><dt>Endpoint</dt><dd>{item.baseUrl}</dd></div> : null}
            <div><dt>Price</dt><dd>{item.price
              ? <>{priceText(item.price)} · {priceSourceText(item.price)}</>
              : 'Unknown. It cannot be used until a price is known; add the key again with a price.'}</dd></div>
            <div><dt>Key</dt><dd>Ending {item.keyLastFour}</dd></div>
          </dl>
          <form className="background-settings__budget" onSubmit={(event) => { event.preventDefault(); void changeBudget(item, new FormData(event.currentTarget).get('dailyBudget')); }}>
            <label>Daily budget (USD)<input name="dailyBudget" type="number" required min={API_KEY_DAILY_BUDGET_CENTS.min / 100} max={API_KEY_DAILY_BUDGET_CENTS.max / 100} step="0.01"
              defaultValue={(item.dailyBudgetCents / 100).toFixed(2)} aria-describedby={`connection-${item.id}-budget`} /></label>
            <Button type="submit" disabled={busy}>Save budget</Button>
          </form>
          <p id={`connection-${item.id}-budget`} className="background-settings__help">Everything on this key counts against it: your agents. At the budget they pause until the next day, from midnight in {item.timeZone}. Flux prices each request before sending it; the provider’s invoice may still differ slightly.</p>
          <div className="background-settings__actions">
            <Button disabled={busy} onClick={() => void disconnect(item)} aria-label={`Remove ${item.name}, key ending ${item.keyLastFour}`}>Remove</Button>
          </div>
          <p className="background-settings__help">Removing deletes this key from Flux. Revoke it at {item.provider === 'openai_compatible' ? 'your endpoint' : AI_PROVIDERS[item.provider].label} too if it should stop working outside Flux.</p>
        </li>)}
      </ul>
    </section> : null}

    {!connections.length || editing ? <section ref={connectSectionRef} className="background-settings__section" aria-labelledby="background-connect">
      <div className="background-settings__section-head">
        <h3 id="background-connect">Use an API key</h3>
        {/* Backing out is possible from the top of a long form, on a phone too. */}
        {connections.length ? <Button variant="quiet" onClick={cancelAdding}>Cancel adding</Button> : null}
      </div>
      <AddKeyForm ref={formRef} {...(connections.length ? { onCancel: cancelAdding } : {})} onAdded={(added) => {
        void listBackgroundConnections().catch(() => [added, ...connections]).then(setConnections);
        // The first key gives a person their Assistant on the server: the shell's agents and the models are read again, so Back to AI is not stale (#959).
        void revalidator.revalidate(); void refreshAssistantModel();
        setEditing(false);
        announce(`Key saved with a daily budget of ${money(added.dailyBudgetCents)}.`);
      }} />
    </section> : null}
    <Link className="background-settings__back" to="/settings/agents">Back to AI</Link>
  </div></div>;
}
