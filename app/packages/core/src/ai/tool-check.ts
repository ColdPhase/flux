import type { AiPrice, AiProviderKind } from '@flux/contracts';
import { RuleViolationError } from '../access/errors.js';

// RT-1 rule 2 (#1441): only models that call tools can be agents, decided by ONE check for every provider, with no table of models and no
// owner's switch. When a key is added in Connect AI, and when another model of a key's list is chosen for an agent, the server sends the
// provider one small request on that model with one tool, `ping`, that the model is asked to call. Called: accepted. Not called, or the
// request refused or failed: `AI_TOOLS_REQUIRED` (422). The request is charged to the key's day like any other (CA-3).

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

/** `chargedMicros`: what the request cost (zero when the provider documents no charge), counted on the key's day. */
export interface ToolCheckResult { callsTools: boolean; chargedMicros: number }

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
