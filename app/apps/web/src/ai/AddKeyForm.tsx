import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AI_PROVIDERS, API_KEY_DAILY_BUDGET_CENTS, isAiProviderKind, type AiProviderKind, type BackgroundComputeConnection,
  type ConnectBackgroundComputeCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Input } from '../ui';
import { connectBackgroundCompute } from './api';
import { ConnectionFields } from './ConnectionFields';
import './background.css';

// The form that adds one API key with its one daily budget (F-020 PROV-1, #854): Provider and API key, then the Model once the key's models
// are read (#1218), already chosen (#1424); the Daily budget (it has a default) and the Name (optional) are behind More. The key exists
// only in its password input and the same-origin requests, never in app storage. The Connect AI window is the one place that shows it.

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const BUDGET_PROBLEM = `Enter a daily budget from ${money(API_KEY_DAILY_BUDGET_CENTS.min)} to ${money(API_KEY_DAILY_BUDGET_CENTS.max)}.`;
/** A daily budget typed in US dollars, in whole cents; null when it is not one Flux accepts. */
export function budgetCents(value: FormDataEntryValue | null): number | null {
  const cents = Math.round(Number(String(value ?? '').trim()) * 100);
  return Number.isInteger(cents) && cents >= API_KEY_DAILY_BUDGET_CENTS.min && cents <= API_KEY_DAILY_BUDGET_CENTS.max ? cents : null;
}
const MODEL_PROBLEM = (provider: AiProviderKind) => (AI_PROVIDERS[provider].keylessModelList
  ? 'Name the model this key uses.' : 'Choose a model first. Flux lists the models of your key once you have entered it and left the field.');
const PRICE_PROBLEM = 'Enter this model’s price to use it with a daily budget: from your provider’s pricing, or 0 for a self-hosted server you pay for otherwise.';
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
/** USD per 1M tokens typed by the owner, in micro-dollars; null when left empty. */
function ownerPrice(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000) : NaN;
}

export function keyFailure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE') return 'This server cannot store background credentials yet. Contact its operator.';
    // The model is refused, not the key (RT-1 rule 2, #1441): the key stays in its field for another model, so only the reason is said.
    if (error.code === 'AI_TOOLS_REQUIRED') return error.message;
    // Provider, model, endpoint and price refusals carry a safe, specific reason.
    if ((error.status === 400 || error.status === 422) && error.code?.startsWith('AI_')) return `${error.message.replace(/\.$/, '')}. The key was cleared; enter it again.`;
    if (error.status === 401) return 'Your session ended. Sign in again before changing the connection.';
    if (error.status === 404) return 'This connection is no longer available. Reload to see your current connection.';
    if (error.status === 400) return 'Flux could not accept these values. The key was cleared; enter it again, then check the provider, model and daily budget.';
  }
  return 'The connection could not be changed. Check your connection to Flux and try again.';
}

/** The form as its page sees it: it can be cleared when the person backs out. */
export interface AddKeyFormHandle { reset(): void; focusFirst(): void }

export const AddKeyForm = forwardRef<AddKeyFormHandle, {
  onAdded: (added: BackgroundComputeConnection) => void;
  onCancel?: () => void;
}>(function AddKeyForm({ onAdded, onCancel }, ref) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The provider refused the key in the field (#1218): Connect waits until it changes.
  const [keyRefused, setKeyRefused] = useState(false);
  // The daily budget and the name are behind More (#1424). Both stay in the form, so a closed More still sends the budget's default;
  // it opens by itself when the problem is in it.
  const [more, setMore] = useState(false);
  const defaultBudget = (API_KEY_DAILY_BUDGET_CENTS.default / 100).toFixed(2);
  const [budgetText, setBudgetText] = useState(defaultBudget);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusError = useRef(false);
  useLayoutEffect(() => {
    if (!focusError.current) return;
    focusError.current = false;
    errorRef.current?.focus();
  });
  useImperativeHandle(ref, () => ({
    reset() { formRef.current?.reset(); setError(''); setMore(false); setBudgetText(defaultBudget); },
    focusFirst() { formRef.current?.querySelector<HTMLSelectElement | HTMLButtonElement>('[name="provider"], button')?.focus({ preventScroll: true }); },
  }), []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const chosen = String(data.get('provider') ?? '');
    if (!isAiProviderKind(chosen)) { setError('Choose a provider before saving.'); return; }
    const input = ownerPrice(data.get('inputPrice'));
    const output = ownerPrice(data.get('outputPrice'));
    if (Number.isNaN(input) || Number.isNaN(output) || (input === null) !== (output === null)) {
      setError('Enter both prices as numbers of US dollars per 1M tokens.'); return;
    }
    const budget = budgetCents(data.get('dailyBudget'));
    if (budget === null) { setMore(true); setError(BUDGET_PROBLEM); return; }
    const name = String(data.get('connectionName') ?? '').trim();
    const model = String(data.get('model') ?? '').trim();
    // Never saved on a model nobody chose: Enter in the key field, or Connect while the models are still being read, stops here.
    if (!model) { setError(MODEL_PROBLEM(chosen)); return; }
    // Never saved on a model that can't be used: the daily budget prices every request, so a model no price list knows needs the
    // owner's price here, in the same step (PROV-3, #1424, #1465); 0 is a price (a server you pay for otherwise). The form asks for the
    // price (its price fields are there) exactly when the list it read does not price the model.
    if (form.elements.namedItem('inputPrice') && input === null) { setError(PRICE_PROBLEM); focusError.current = true; return; }
    const command: ConnectBackgroundComputeCommand = {
      ...(name ? { name } : {}),
      provider: chosen, model,
      ...(chosen === 'openai_compatible' ? { baseUrl: String(data.get('baseUrl') ?? '').trim() } : {}),
      ...(input !== null && output !== null ? { price: { inputMicrosPerMTok: input, outputMicrosPerMTok: output } } : {}),
      apiKey: String(data.get('apiKey') ?? '').trim(),
      dailyBudgetCents: budget, timeZone: browserZone(),
    };
    setBusy(true); setError('');
    // A model that cannot use tools is refused with the key still good: the key stays in its field, so another model can be chosen.
    let keepKey = false;
    try {
      onAdded(await connectBackgroundCompute(command));
    } catch (cause) {
      keepKey = cause instanceof ApiError && cause.code === 'AI_TOOLS_REQUIRED';
      if (cause instanceof ApiError && cause.code?.startsWith('AI_BUDGET')) setMore(true);
      setError(keyFailure(cause)); focusError.current = true;
    }
    finally {
      const key = form.elements.namedItem('apiKey');
      if (!keepKey && key instanceof HTMLInputElement) key.value = '';
      command.apiKey = ''; data.delete('apiKey');
      setBusy(false);
    }
  }

  return <>
    {error ? <p id="background-connect-error" ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
    <form ref={formRef} onSubmit={(event) => void connect(event)}>
      <fieldset disabled={busy} className="background-settings__fields">
        <ConnectionFields disabled={busy} onKeyRefused={setKeyRefused} keyHelpId="background-key-help" />
        <div className="background-settings__more-row">
          <Button variant="quiet" size="sm" icon={more ? 'chevron-down' : 'chevron-right'} aria-label="More settings" aria-expanded={more} aria-controls="background-more"
            onClick={() => setMore(!more)}>More</Button>
          {more ? null : <span className="background-settings__help" data-testid="budget-line">Daily budget ${budgetText.trim() || '?'}</span>}
        </div>
        <div id="background-more" className="background-settings__fields" hidden={!more}>
          <Input label="Daily budget (USD)" name="dailyBudget" inputMode="decimal" autoComplete="off" defaultValue={defaultBudget}
            onChange={(event) => setBudgetText(event.target.value)} aria-describedby="background-budget-help" />
          <p id="background-budget-help" className="background-settings__help">Your agents stop for the day when this is used up.</p>
          <label>Name (optional)<input name="connectionName" autoComplete="off" maxLength={80} placeholder="For example: Work OpenRouter" /></label>
        </div>
        {/* Cancel, then the one primary, on the right: the choose step's Cancel and Continue keep their side here (#1424). */}
        <div className="background-settings__actions background-settings__actions--end">
          {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
          <Button type="submit" variant="primary" busy={busy} disabled={keyRefused}>Connect</Button>
        </div>
      </fieldset>
    </form>
  </>;
});
