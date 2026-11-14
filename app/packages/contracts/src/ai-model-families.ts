import type { AiProviderKind } from './ai-providers.js';

// How a key's model list is shown (CA-2, #1218): grouped by family (Opus, Sonnet, Haiku, Fable…), the newest family and model
// first. Anthropic names a model's line in its list (`line`); the other providers' families are read from the id, the only thing
// their lists give. Shared by the server's listing and the dropdown, so both order the models the same way.

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The family a model is grouped under in the picker. `line` is Anthropic's own (`opus`, `sonnet`, …) where its list gave one. */
export function aiModelFamily(provider: AiProviderKind, id: string, line?: string | null): string {
  const lower = id.toLowerCase();
  if (provider === 'anthropic') {
    if (line && /^[a-z]{2,20}$/.test(line)) return capital(line);
    const named = /^claude-([a-z]+)-/.exec(lower);
    return named ? capital(named[1]!) : 'Other';
  }
  if (provider === 'openai') {
    const tier = /^gpt-[\d.]+-(astra|sol|terra|luna)\b/.exec(lower);
    if (tier) return capital(tier[1]!);
    if (/^(gpt-[\d.]+|o\d+)-pro\b/.test(lower)) return 'Pro';
    const size = /^gpt-[\d.]+o?-(mini|nano)\b/.exec(lower);
    if (size) return capital(size[1]!);
    if (/^gpt-/.test(lower)) return 'GPT';
    return /^o\d/.test(lower) ? 'o-series' : 'Other';
  }
  if (provider === 'gemini') {
    const named = /^gemini-[\d.]+-(carbon|argon)\b/.exec(lower);
    if (named) return capital(named[1]!);
    if (lower.includes('flash-lite')) return 'Flash-Lite';
    if (lower.includes('flash')) return 'Flash';
    return lower.includes('pro') ? 'Pro' : 'Other';
  }
  if (provider === 'openrouter') {
    const vendor = /^([a-z0-9][a-z0-9._-]*)\//.exec(lower);
    return vendor ? vendor[1]! : 'Other';
  }
  return 'Models';
}

/** The version numbers in an id without a date snapshot suffix: `claude-opus-4-5-20251101` → [4, 5], `gpt-6.1-sol` → [6, 1]. */
function versionOf(id: string): number[] {
  const bare = id.toLowerCase().replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return (bare.match(/\d+/g) ?? []).slice(0, 4).map(Number);
}

/** Newest first: by the provider's release date where both have one, then by the version in the id, then by id. */
export function compareModelsNewestFirst(a: { id: string; createdAt?: string | null }, b: { id: string; createdAt?: string | null }): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  // An epoch date means the provider does not know it (Anthropic's documented fallback).
  if (Number.isFinite(at) && Number.isFinite(bt) && at > 0 && bt > 0 && at !== bt) return bt - at;
  const av = versionOf(a.id);
  const bv = versionOf(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    const diff = (bv[i] ?? -1) - (av[i] ?? -1);
    if (diff) return diff;
  }
  // A dateless id (the alias) before its dated snapshot, then by id.
  return a.id.length - b.id.length || a.id.localeCompare(b.id);
}

export interface AiModelFamilyGroup<T> { family: string; models: T[] }

/** The models in their families: each family newest first, and the family with the newest model first. */
export function groupModelsByFamily<T extends { id: string; family?: string; createdAt?: string | null }>(models: readonly T[]): AiModelFamilyGroup<T>[] {
  const families = new Map<string, T[]>();
  for (const model of [...models].sort(compareModelsNewestFirst)) {
    const family = model.family || 'Other';
    families.set(family, [...(families.get(family) ?? []), model]);
  }
  return [...families.entries()].map(([family, items]) => ({ family, models: items }))
    .sort((a, b) => compareModelsNewestFirst(a.models[0]!, b.models[0]!));
}

/**
 * The family Connect AI preselects for a provider whose models are listed with the key (founder decision, Hubert, 2026-11-14, #1424, CA-2): the
 * provider's middle, balanced model, found by family name in the provider's current list. Anthropic's Sonnet, OpenAI's Sol (Astra is its top
 * tier and Luna its cheap one) and Gemini's Flash (not Flash-Lite, not Pro). Opus, Fable and the cheaper models stay in the list to be chosen.
 */
export const AI_DEFAULT_MODEL_FAMILY: Readonly<Partial<Record<AiProviderKind, string>>> = { anthropic: 'Sonnet', openai: 'Sol', gemini: 'Flash' };

/**
 * The model Connect AI has chosen when a list is read (#1424): the only model of a list of one; for Anthropic, OpenAI and Gemini the newest
 * model of their middle family (`AI_DEFAULT_MODEL_FAMILY`), else, only when the list has no such family, the first model as the dropdown
 * orders them. A long keyless list (OpenRouter's, an endpoint's) has none: there is no sensible one among hundreds, so its owner picks.
 */
export function defaultListedModel<T extends { id: string; family?: string; createdAt?: string | null }>(provider: AiProviderKind, models: readonly T[]): T | undefined {
  if (models.length === 1) return models[0];
  const family = AI_DEFAULT_MODEL_FAMILY[provider];
  if (!family) return undefined;
  const groups = groupModelsByFamily(models);
  return (groups.find((group) => group.family === family) ?? groups[0])?.models[0];
}
