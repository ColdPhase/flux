// TEST ONLY: the models the fake CLIs offer their account (#1332), in the shapes the pinned CLIs gave on 2026-11-12 (captured account-free in
// Docker: Claude Code 2.1.285's `initialize` answer and Codex 0.160.1's app-server `model/list`; evidence in the issue). A test replaces them
// with `fake-models.json` in the CLI's home (an array of the same entries).

/** Claude Code's `initialize` answer `models`: the account's default, three aliases and Fable, which Flux drops. */
export const FAKE_CLAUDE_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', supportsEffort: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', supportsEffort: true },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok', supportsEffort: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
];

const codexModel = (id: string, displayName: string, description: string, extra: Record<string, unknown> = {}) => ({
  id, model: id, upgrade: null, upgradeInfo: null, availabilityNux: null, displayName, description, modelSpecialty: null, hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' }], defaultReasoningEffort: 'low',
  inputModalities: ['text', 'image'], supportsPersonality: false, multiAgentVersion: 'v2', additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null,
  availableAccessPrograms: null, isDefault: false, ...extra,
});

/** Codex's `model/list` `data` for this account: three visible models and one hidden. The pinned catalog has two more the account lacks. */
export const FAKE_CODEX_MODELS = [
  codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', { isDefault: true }),
  codexModel('gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.'),
  codexModel('gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.'),
  codexModel('gpt-6-preview', 'GPT-6-Preview', 'Hidden from the default picker.', { hidden: true }),
];

/** The vendor catalog (`models.json`) of the fake pinned Codex: the account's models and two it lacks (`gpt-6-sol`, `gpt-5.5`), each coded as the pinned file does. */
export const FAKE_CODEX_CATALOG = {
  models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-6-preview'].map((slug) => ({
    slug, display_name: slug, description: slug, visibility: 'list', tool_mode: 'code_mode_only', multi_agent_version: 'v2', shell_type: 'shell_command',
  })),
};
