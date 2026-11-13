import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AI_PROVIDERS, API_KEY_DAILY_BUDGET_CENTS, isAiProviderKind, type AiProviderKind, type BackgroundComputeConnection,
  type ConnectBackgroundComputeCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button } from '../ui';
import { connectBackgroundCompute } from './api';
import { ConnectionFields } from './ConnectionFields';
import './background.css';

// The form that adds one API key with its one daily budget (F-020 PROV-1, #854): Provider, API key, Model (#1218), Daily budget,
// Name. The key exists only in its password input and the same-origin requests, never in app storage. The page of keys and the
// Connect AI window share it.

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const BUDGET_PROBLEM = `Enter a daily budget from ${money(API_KEY_DAILY_BUDGET_CENTS.min)} to ${money(API_KEY_DAILY_BUDGET_CENTS.max)}.`;
/** A daily budget typed in US dollars, in whole cents; null when it is not one Flux accepts. */
export function budgetCents(value: FormDataEntryValue | null): number | null {
  const cents = Math.round(Number(String(value ?? '').trim()) * 100);
  return Number.isInteger(cents) && cents >= API_KEY_DAILY_BUDGET_CENTS.min && cents <= API_KEY_DAILY_BUDGET_CENTS.max ? cents : null;
}
const MODEL_PROBLEM = (provider: AiProviderKind) => (AI_PROVIDERS[provider].keylessModelList
  ? 'Name the model this key uses.' : 'Choose a model first. Flux lists the models of your key once you have entered it and left the field.');
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
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusError = useRef(false);
  useLayoutEffect(() => {
    if (!focusError.current) return;
    focusError.current = false;
    errorRef.current?.focus();
  });
  useImperativeHandle(ref, () => ({
    reset() { formRef.current?.reset(); setError(''); },
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
      setError('Enter both prices as numbers of US dollars per 1M tokens, or leave both empty.'); return;
    }
    const budget = budgetCents(data.get('dailyBudget'));
    if (budget === null) { setError(BUDGET_PROBLEM); return; }
    const name = String(data.get('connectionName') ?? '').trim();
    const model = String(data.get('model') ?? '').trim();
    // Never saved on a model nobody chose: Enter in the key field, or Connect while the models are still being read, stops here.
    if (!model) { setError(MODEL_PROBLEM(chosen)); return; }
    const command: ConnectBackgroundComputeCommand = {
      ...(name ? { name } : {}),
      provider: chosen, model,
      ...(chosen === 'openai_compatible' ? { baseUrl: String(data.get('baseUrl') ?? '').trim() } : {}),
      ...(input !== null && output !== null ? { price: { inputMicrosPerMTok: input, outputMicrosPerMTok: output } } : {}),
      apiKey: String(data.get('apiKey') ?? '').trim(),
      dailyBudgetCents: budget, timeZone: browserZone(),
    };
    setBusy(true); setError('');
    try {
      onAdded(await connectBackgroundCompute(command));
    } catch (cause) { setError(keyFailure(cause)); focusError.current = true; }
    finally {
      const key = form.elements.namedItem('apiKey');
      if (key instanceof HTMLInputElement) key.value = '';
      command.apiKey = ''; data.delete('apiKey');
      setBusy(false);
    }
  }

  return <>
    {error ? <p id="background-connect-error" ref={errorRef} className="background-settings__error" role="alert" tabIndex={-1}>{error}</p> : null}
    <p className="background-settings__help">Anthropic, OpenAI, OpenRouter, Gemini or an OpenAI-compatible endpoint, including a self-hosted model. An Anthropic key from a Console organization linked to a Claude Max, Ultra or Team plan uses that plan’s monthly API credits.</p>
    <form ref={formRef} onSubmit={(event) => void connect(event)}>
      <fieldset disabled={busy} className="background-settings__fields">
        <ConnectionFields disabled={busy} onKeyRefused={setKeyRefused} keyHelpId="background-key-help" />
        <label>Daily budget (USD)<input name="dailyBudget" type="number" required min={API_KEY_DAILY_BUDGET_CENTS.min / 100} max={API_KEY_DAILY_BUDGET_CENTS.max / 100} step="0.01"
          defaultValue={(API_KEY_DAILY_BUDGET_CENTS.default / 100).toFixed(2)} aria-describedby="background-budget-help" /></label>
        <p id="background-budget-help" className="background-settings__help">Your agents pause for the day when it’s used. It’s the only limit.</p>
        <label>Name<input name="connectionName" autoComplete="off" maxLength={80} placeholder="For example: Work OpenRouter" /></label>
        <div className="background-settings__actions">
          <Button type="submit" variant="primary" busy={busy} disabled={keyRefused}>Connect</Button>
          {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        </div>
      </fieldset>
    </form>
  </>;
});
