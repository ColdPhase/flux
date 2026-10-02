import { useEffect, useId, useState } from 'react';
import { AI_PROVIDER_KINDS, AI_PROVIDERS, AI_PRICE_TABLE, BACKGROUND_COMPARISON_LIMITS, maxRequestMicros, tablePrice,
  type AiModelList, type AiPrice, type AiProviderKind, type BackgroundComputeConnection } from '@flux/contracts';
import { Button } from '../ui';
import { listAiModels } from './api';

// Provider, model, endpoint and price of an owner's AI connection (F-020, #179). Every provider is
// offered the same way; none is preselected. Models come from the provider's own list when the
// server can read it without a key, otherwise the owner types the id. A price comes from Flux's
// dated table when it has the model; otherwise the owner enters it (PROV-3). A price the provider
// lists is only offered as the starting value of the owner's price.

/** USD per 1M tokens for an input field, from micro-dollars. */
const usd = (micros: number) => String(micros / 1_000_000);

const perMillion = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 4)}`;
const cents = (micros: number) => `$${(Math.ceil(micros / 10_000) / 100).toFixed(2)}`;

export function priceSourceText(price: AiPrice) {
  return price.source === 'table' ? `Flux price table, checked ${price.checkedOn}` : 'Entered by you';
}

export const priceText = (price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>) =>
  `${perMillion(price.inputMicrosPerMTok)} input · ${perMillion(price.outputMicrosPerMTok)} output per 1M tokens`;

/** The O-007 reservation of one comparison request at a price: its largest cost, at least $0.05. */
export function comparisonReserveText(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>) {
  const micros = Math.max(BACKGROUND_COMPARISON_LIMITS.minimumReserveCents * 10_000,
    maxRequestMicros(price, BACKGROUND_COMPARISON_LIMITS.maxInputTokens, BACKGROUND_COMPARISON_LIMITS.maxOutputTokens));
  return cents(micros);
}

const listFailure: Record<Exclude<AiModelList['status'], 'listed'>, string> = {
  needs_key: 'This provider lists its models only with your key, which this page never uses. Type the model id from the provider’s documentation.',
  unavailable: 'The model list could not be read. Type the model id.',
  refused: 'This endpoint is not allowed on this server. Use a public HTTPS address, or ask the operator to allow a private one.',
};

export function ConnectionFields({ connection, disabled, onProvider }: {
  connection: BackgroundComputeConnection | null; disabled: boolean; onProvider: (provider: AiProviderKind | '') => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState<AiProviderKind | ''>(connection?.provider ?? '');
  useEffect(() => { onProvider(provider); }, [provider, onProvider]);
  const [model, setModel] = useState(connection?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [list, setList] = useState<AiModelList | null>(null);
  const [listing, setListing] = useState(false);
  const [listStatus, setListStatus] = useState('');
  const info = provider ? AI_PROVIDERS[provider] : null;
  const listed = list?.provider === provider ? list.models : [];
  const suggestions = provider ? [...new Set([...listed.map((entry) => entry.id), ...AI_PRICE_TABLE.filter((entry) => entry.provider === provider).map((entry) => entry.model)])] : [];
  const listedPrice = listed.find((entry) => entry.id === model)?.price ?? null;
  const table = provider && model ? tablePrice(provider, model) : null;

  async function showModels() {
    if (!provider || listing) return;
    setListing(true); setListStatus('');
    try {
      const result = await listAiModels({ provider, ...(provider === 'openai_compatible' ? { baseUrl: baseUrl.trim() } : {}) });
      setList(result);
      setListStatus(result.status === 'listed' ? `${result.models.length} ${result.models.length === 1 ? 'model' : 'models'} from ${AI_PROVIDERS[provider].label}. Choose one in Model.` : listFailure[result.status]);
    } catch { setListStatus('The model list could not be read. Type the model id.'); }
    finally { setListing(false); }
  }

  return <>
    <label>Provider
      <select name="provider" required value={provider} disabled={disabled}
        onChange={(event) => { setProvider(event.target.value as AiProviderKind | ''); setList(null); setListStatus(''); }}>
        <option value="">Choose a provider</option>
        {AI_PROVIDER_KINDS.map((kind) => <option key={kind} value={kind}>{AI_PROVIDERS[kind].label}</option>)}
      </select>
    </label>
    {provider === 'openai_compatible' ? <>
      <label>Endpoint base URL<input name="baseUrl" type="url" required maxLength={2048} autoComplete="off" spellCheck={false}
        placeholder="https://llm.example.org/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-describedby={`${id}-endpoint`} /></label>
      <p id={`${id}-endpoint`} className="background-settings__help">The server that speaks the OpenAI Chat Completions format, such as Ollama, vLLM, LM Studio or a gateway. Public HTTPS only, unless this server’s operator allows a private address. Flux checks it when you save and before every request, and never follows a redirect.</p>
    </> : null}
    <label>Model<input name="model" required maxLength={200} autoComplete="off" spellCheck={false} list={`${id}-models`}
      value={model} onChange={(event) => setModel(event.target.value)} aria-describedby={`${id}-model`} /></label>
    <datalist id={`${id}-models`}>{suggestions.map((entry) => <option key={entry} value={entry} />)}</datalist>
    <div id={`${id}-model`} className="background-settings__model-help">
      {info?.keylessModelList
        ? <Button disabled={disabled || listing || (provider === 'openai_compatible' && !baseUrl.trim())} busy={listing} onClick={() => void showModels()}>Show available models</Button>
        : null}
      <p className="background-settings__help" role="status">{listStatus || (provider && !info?.keylessModelList ? 'Type the model id exactly as the provider names it.' : '')}</p>
    </div>
    {provider && model ? table
      ? <p className="background-settings__help" data-testid="connection-price">Price: {priceText(table)} · Flux price table, checked {table.checkedOn}. One request reserves up to {comparisonReserveText(table)}.</p>
      // Remounted per model, so a listed price becomes the starting value of the owner's price.
      : <fieldset key={`${provider}:${model}`} className="background-settings__price" disabled={disabled}>
        <legend>Price per 1M tokens (USD)</legend>
        <p className="background-settings__help">Flux’s price table does not have this model. Enter its price from your provider’s pricing; enter 0 for a self-hosted server you pay for otherwise. Flux reserves the most one request can cost at this price. Without a price, the connection can be saved but no rule or assistant can use it.</p>
        {listedPrice ? <p className="background-settings__help" data-testid="listed-price">{info!.label} lists {priceText(listedPrice)} (read {list!.checkedOn}); it is filled in below for you to confirm.</p> : null}
        <div className="background-settings__limits">
          <label>Input price<input name="inputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" defaultValue={listedPrice ? usd(listedPrice.inputMicrosPerMTok) : undefined} /></label>
          <label>Output price<input name="outputPrice" type="number" min="0" max="1000" step="any" inputMode="decimal" defaultValue={listedPrice ? usd(listedPrice.outputMicrosPerMTok) : undefined} /></label>
        </div>
      </fieldset> : null}
  </>;
}
