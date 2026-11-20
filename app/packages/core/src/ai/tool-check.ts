import { AI_PROVIDERS, type AiPrice, type AiProviderKind } from '@flux/contracts';
import { InvalidInputError, RuleViolationError } from '../access/errors.js';

// RT-1 rule 2 (#1441): only models that call tools can be agents, decided by ONE check for every provider, with no table of models and no
// owner's switch. When a key is added in Connect AI, and when another model of a key's list is chosen for an agent, the server sends the
// provider one small request on that model with one tool, `ping`, that the model is asked to call. Called: accepted. Not called, or the
// request failed after it reached the model: `AI_TOOLS_REQUIRED` (422). A 401 or 403 is the key refused, not the model (#1594):
// `AI_KEY_REFUSED`. The request is charged to the key's day like any other (CA-3).

/** The one question: the model, the provider and endpoint it is asked on, the key, and the price the request is charged at. */
export interface ToolCheckProbe {
  provider: AiProviderKind;
  /** `openai_compatible` only. */
  baseUrl: string | null;
  model: string;
  /** What the check is charged at (PROV-3): it can be sent only once the model's price is known. */
  price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>;
  /** The key being added (Connect AI), or the sealed key of a connection the server opens for this one request. */
  key: { apiKey: string } | { connectionId: string };
}

/**
 * `chargedMicros`: what the request cost (zero when the provider documents no charge), counted on the key's day. `keyRefused`: the provider
 * answered 401 or 403 (#1594), so the model was never asked and the key is what to fix.
 */
export interface ToolCheckResult { callsTools: boolean; chargedMicros: number; keyRefused?: true }

export type ToolCheck = (probe: ToolCheckProbe) => Promise<ToolCheckResult>;

/**
 * What choosing another model of a key for an agent needs: the check, and the checks kept for the key (`api_key_checks`), so a model that
 * passed once is not asked again. `record` is written on a handle of its own, never in the transaction of the change being made (which waited
 * for the provider and may be refused), so a refused model's cost stays counted on the key's day.
 */
export interface ToolChecking {
  check: ToolCheck;
  passed(connectionId: string, model: string): Promise<boolean>;
  record(check: { connectionId: string; model: string; callsTools: boolean; chargedMicros: number }): Promise<void>;
}

/** The refusal, the same words and code for every provider. */
export const TOOLS_REQUIRED_MESSAGE = 'This model can\'t use tools. Choose another.';
export const toolsRequired = () => new RuleViolationError(TOOLS_REQUIRED_MESSAGE, 'AI_TOOLS_REQUIRED');

/** A key its provider refused (401 or 403), to its listing or to the check: the same words as the Connect AI form's list (CA-2, #1594). */
export const keyRefused = (provider: AiProviderKind) =>
  new InvalidInputError(`This key was refused by ${provider === 'openai_compatible' ? 'the endpoint' : AI_PROVIDERS[provider].label}`, 'AI_KEY_REFUSED');
/** What the check's answer refuses: the key when the provider refused it, else the model when it did not call `ping`; null when accepted. */
export const toolCheckRefusal = (provider: AiProviderKind, checked: ToolCheckResult) =>
  checked.keyRefused ? keyRefused(provider) : checked.callsTools ? null : toolsRequired();
