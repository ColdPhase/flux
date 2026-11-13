import { useEffect, useId, useRef, useState } from 'react';
import { AI_PROVIDER_KINDS, AI_PROVIDERS, assistantModelName, groupModelsByFamily, listPrice,
  type AiListedModel, type AiModelList, type AiPrice, type AiProviderKind, type AiProviderPriceList } from '@flux/contracts';
import { Button, Select, Option, OptionGroup } from '../ui';
import { ApiError } from '../api/client';
import { listAiModels } from './api';

// Provider, API key, model, endpoint and price of an owner's AI connection (F-020, #179; CA-2, #1218), in that order: the key
// comes before the model because the model list is the key's own. Every provider is offered the same way; none is preselected.
// - Anthropic, OpenAI and Gemini: when the key field is left, the server lists the models that key can use, and that one call is
//   also the key's test. The Model is then a dropdown by family, newest first, each with its price or "price unknown, enter it",
//   and "Other model id…" for an id the list lacks. A refused key says so and Connect waits for another; a list that can't be
//   read leaves the plain field with a note.
// - OpenRouter and an OpenAI-compatible endpoint list without a key ("Show available models"), with the plain field as fallback.
// No model list is written into Flux: the models are only ever the provider's own (founder direction, Hubert, 2026-11-12), and
// Flux's price list only prices one.
// A price comes from Flux's price list, which the server refreshes every day and sends with the model list (#1465); when it has no
// price for the model, the owner enters it (PROV-3), for every provider alike. A price the provider lists (OpenRouter) is only offered
// as the starting value of the owner's price. The key exists only in its password field and the request.

/** USD per 1M tokens for an input field, from micro-dollars. */
const usd = (micros: number) => String(micros / 1_000_000);

const perMillion = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 4)}`;
/** "$4", "$0.50": a short price for a dropdown option. */
const short = (micros: number) => {
  const value = micros / 1_000_000;
  return `$${Number.isInteger(value) ? value : value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}`;
};

/** "12 Nov 2026" from the price list's ISO day. */
export const checkedDay = (isoDay: string) => {
  const day = new Date(`${isoDay}T12:00:00Z`);
  return Number.isNaN(day.getTime()) ? isoDay : day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export function priceSourceText(price: AiPrice) {
  return price.source === 'list' ? (price.checkedOn ? `Flux’s price list of ${checkedDay(price.checkedOn)}` : 'Flux’s price list') : 'Entered by you';
}

export const priceText = (price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>) =>
  `${perMillion(price.inputMicrosPerMTok)} input · ${perMillion(price.outputMicrosPerMTok)} output per 1M tokens`;

/** Providers whose models the server lists with the key being added (#1218). */
const KEY_LISTED: ReadonlySet<AiProviderKind> = new Set(['anthropic', 'openai', 'gemini']);
const OTHER = '__other__';

const listFailure = (provider: AiProviderKind, status: Exclude<AiModelList['status'], 'listed'>) => {
  const label = AI_PROVIDERS[provider].label;
  switch (status) {
    case 'key_refused': return `This key was refused by ${label}. Check it and try again.`;
    case 'refused': return 'This endpoint is not allowed on this server. Use a public HTTPS address, or ask the operator to allow a private one.';
    case 'needs_key': return 'Enter the API key first.';
    default: return KEY_LISTED.has(provider)
      ? `${label}’s model list couldn’t be read. Type the model id from ${label}’s documentation.`
      : 'The model list could not be read. Type the model id.';
  }
};

/** The model's name in the dropdown, with its price or that Flux doesn't know it. */
function optionText(prices: AiProviderPriceList | null, model: AiListedModel) {
  const name = model.name ?? assistantModelName(model.id);
  const row = listPrice(prices, model.id);
  return row ? `${name} · ${short(row.inputMicrosPerMTok)} / ${short(row.outputMicrosPerMTok)}` : `${name} · price unknown, enter it`;
}

type Listing = { state: 'idle' } | { state: 'reading' } | { state: 'done'; list: AiModelList } | { state: 'failed' };

/** A listing refused as busy is asked again after this wait, this many times: more than a listing's 8 s in all. */
const LIST_BUSY_WAIT_MS = 2_000;
const LIST_BUSY_TRIES = 5;

export function ConnectionFields({ disabled, onKeyRefused, keyHelpId }: {
  disabled: boolean;
  /** Whether the provider refused the key now in the field: Connect waits for another key (#1218). */
  onKeyRefused: (refused: boolean) => void;
  /** The key help the form shows under the key field. */
  keyHelpId: string;
}) {
  const id = useId();
  const [provider, setProvider] = useState<AiProviderKind | ''>('');
  const [model, setModel] = useState('');
  const [other, setOther] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [listing, setListing] = useState<Listing>({ state: 'idle' });
  // The key last listed, so leaving the field again without a change asks nothing; only in memory, like the field itself.
  const listedKey = useRef('');
  const asked = useRef(0);
  const info = provider ? AI_PROVIDERS[provider] : null;
  const keyed = !!provider && KEY_LISTED.has(provider);
  const list = listing.state === 'done' && listing.list.provider === provider ? listing.list : null;
  const listed = list?.status === 'listed' ? list.models : null;
  const refused = list?.status === 'key_refused';
  useEffect(() => { onKeyRefused(refused); }, [refused, onKeyRefused]);
  const listedPrice = listed?.find((entry) => entry.id === model)?.price ?? null;
  // Flux's prices of the provider come with its model list, read or not (#1465).
  const prices = list?.priceList ?? null;
  const known = provider && model ? listPrice(prices, model) : null;
  // A dropdown once the provider listed models; the plain field before a key is typed (OpenRouter, an endpoint), when the list
  // couldn't be read, and for "Other model id…".
  const dropdown = !!listed && listed.length > 0;
  const field = !dropdown || other;
  const waitingForKey = keyed && (listing.state === 'idle' || listing.state === 'reading' || refused);

  function choose(next: AiProviderKind | '') {
    setProvider(next); setListing({ state: 'idle' }); setOther(false); listedKey.current = ''; setModel('');
  }

  /**
   * The server reads one list at a time for a person (#1347): a key typed again while the last one is still being read waits for it, with
   * "Reading the models…" all along, instead of being told the list could not be read. Null when a newer ask took over while it waited.
   */
  async function readList(kind: AiProviderKind, query: { apiKey?: string }, ask: number): Promise<AiModelList | null> {
    for (let tries = 0; ; tries += 1) {
      try { return await listAiModels({ provider: kind, ...(kind === 'openai_compatible' ? { baseUrl: baseUrl.trim() } : {}), ...query }); } catch (error) {
        if (!(error instanceof ApiError && error.code === 'MODEL_LIST_BUSY') || tries >= LIST_BUSY_TRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, LIST_BUSY_WAIT_MS));
        if (ask !== asked.current) return null;
      }
    }
  }

  async function read(query: { apiKey?: string }) {
    if (!provider) return;
    const ask = ++asked.current;
    setListing({ state: 'reading' });
    try {
      const result = await readList(provider, query, ask);
      if (!result || ask !== asked.current) return;
      setListing({ state: 'done', list: result });
      if (result.status === 'listed' && result.models.length) {
        // Nothing is preselected: the models are the provider's own, and the owner picks one (#1218).
        setModel((current) => (result.models.some((entry) => entry.id === current) ? current : ''));
        setOther(false);
      }
    } catch {
      if (ask === asked.current) setListing({ state: 'failed' });
    }
  }

  function keyLeft(value: string) {
    const apiKey = value.trim();
    if (!keyed || apiKey.length < 8 || apiKey === listedKey.current) return;
    listedKey.current = apiKey;
    void read({ apiKey });
  }

  const status = listing.state === 'reading' ? (keyed ? `Reading ${info!.label}’s models…` : 'Reading the models…')
    : listing.state === 'failed' ? (provider ? listFailure(provider, 'unavailable') : '')
      : list && list.status !== 'listed' ? (refused ? '' : listFailure(provider as AiProviderKind, list.status))
        : list && dropdown ? `${list.models.length} ${list.models.length === 1 ? 'model' : 'models'} from ${info!.label}.`
          : list ? listFailure(provider as AiProviderKind, 'unavailable') : '';

  return <>
    <label>Provider
      {/* Named explicitly: inside its label, the options would otherwise join the field's name. */}
      <Select name="provider" aria-label="Provider" required value={provider} disabled={disabled} onChange={(next) => choose(next as AiProviderKind | '')}>
        <Option value="">Choose a provider</Option>
        {AI_PROVIDER_KINDS.map((kind) => <Option key={kind} value={kind}>{AI_PROVIDERS[kind].label}</Option>)}
      </Select>
    </label>
    {provider === 'openai_compatible' ? <>
      <label>Endpoint base URL<input name="baseUrl" type="url" required maxLength={2048} autoComplete="off" spellCheck={false}
        placeholder="https://llm.example.org/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-describedby={`${id}-endpoint`} /></label>
      <p id={`${id}-endpoint`} className="background-settings__help">The server that speaks the OpenAI Chat Completions format, such as Ollama, vLLM, LM Studio or a gateway. Public HTTPS only, unless this server’s operator allows a private address. Flux checks it when you save and before every request, and never follows a redirect.</p>
    </> : null}
    <label>API key<input name="apiKey" type="password" autoComplete="off" spellCheck={false} required minLength={8} maxLength={512}
      aria-invalid={refused || undefined} aria-describedby={`${keyHelpId}${refused ? ` ${id}-refused` : ''}`}
      onBlur={(event) => keyLeft(event.currentTarget.value)}
      // Enter before the models are read reads them (the key's test) instead of saving: the form never goes on without a chosen model.
      onKeyDown={(event) => { if (event.key === 'Enter' && waitingForKey) { event.preventDefault(); keyLeft(event.currentTarget.value); } }}
      onChange={() => { if (refused) { setListing({ state: 'idle' }); listedKey.current = ''; } }} /></label>
    {refused ? <p id={`${id}-refused`} className="background-settings__error" role="alert">{listFailure(provider as AiProviderKind, 'key_refused')}</p> : null}
    <p id={keyHelpId} className="background-settings__help">{info ? info.keyHint : 'Choose a provider first to see what its keys look like.'} {keyed ? 'Flux reads the models this key can use when you leave the field.' : ''} This field is cleared after every save attempt; enter it again to try again.</p>
    {dropdown ? (
      <label>Model
        <Select name={other ? undefined : 'model'} required={!other} aria-label="Model" value={other ? OTHER : model} placeholder="Choose a model" disabled={disabled} aria-describedby={`${id}-model`}
          onChange={(next) => { if (next === OTHER) { setOther(true); setModel(''); } else { setOther(false); setModel(next); } }}>
          {groupModelsByFamily(listed!).map((group) => (
            <OptionGroup key={group.family} label={group.family}>
              {group.models.map((entry) => <Option key={entry.id} value={entry.id}>{optionText(prices, entry)}</Option>)}
            </OptionGroup>
          ))}
          <Option value={OTHER}>Other model id…</Option>
        </Select>
      </label>
    ) : null}
    {field && !(waitingForKey && !other) ? (
      <label>{dropdown ? 'Model id' : 'Model'}<input name="model" required maxLength={200} autoComplete="off" spellCheck={false}
        value={model} onChange={(event) => setModel(event.target.value)} aria-describedby={`${id}-model`} /></label>
    ) : null}
    {keyed && waitingForKey && !dropdown ? (
      <label>Model<Select aria-label="Model" value="" placeholder={refused ? 'Enter a key its provider accepts' : 'Enter the API key first'} disabled onChange={() => undefined} aria-describedby={`${id}-model`} /></label>
    ) : null}
    <div id={`${id}-model`} className="background-settings__model-help">
      {info?.keylessModelList
        ? <Button disabled={disabled || listing.state === 'reading' || (provider === 'openai_compatible' && !baseUrl.trim())} busy={listing.state === 'reading'} onClick={() => void read({})}>Show available models</Button>
        : null}
      <p className="background-settings__help" role="status">{status || (provider && !keyed && !dropdown ? 'Type the model id exactly as the provider names it.' : '')}</p>
    </div>
    {provider && model && !waitingForKey ? known
      ? <p className="background-settings__help" data-testid="connection-price">Price: {priceText(known)} · {priceSourceText(known)}.</p>
      // Remounted per model, so a listed price becomes the starting value of the owner's price.
      : <fieldset key={`${provider}:${model}`} className="background-settings__price" disabled={disabled}>
        <legend>Price per 1M tokens (USD)</legend>
        <p className="background-settings__help">Flux doesn’t know this model’s price yet. Enter it to use it with a daily budget: from your provider’s pricing, or 0 for a self-hosted server you pay for otherwise. Flux prices each request at it before sending, so your daily budget holds.</p>
        {listedPrice ? <p className="background-settings__help" data-testid="listed-price">{info!.label} lists {priceText(listedPrice)} (read {list!.checkedOn}); it is filled in below for you to confirm.</p> : null}
        <div className="background-settings__limits">
          <label>Input price<input name="inputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" defaultValue={listedPrice ? usd(listedPrice.inputMicrosPerMTok) : undefined} /></label>
          <label>Output price<input name="outputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" defaultValue={listedPrice ? usd(listedPrice.outputMicrosPerMTok) : undefined} /></label>
        </div>
      </fieldset> : null}
  </>;
}
