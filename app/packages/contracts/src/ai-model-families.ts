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
