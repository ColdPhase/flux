import type { RuntimeClient, RuntimeLoginMethod, RunCaps } from '@flux/runtime-protocol';

// The fixed command templates of the runtime (F-022 "Sign-in as in a terminal", "Run" and "Hardening").
// The supervisor builds every CLI command here and nowhere else; a request only fills in data that was
// already checked against the protocol's patterns. The flag contract check (contract/check-flags.ts)
// reads the same templates, so a flag Flux uses cannot drift from what the pinned CLI documents.

/** Claude Code comes from the tools volume (never in an image); Codex is in the runtime image. */
export const CLI_PATHS: Record<RuntimeClient, string> = {
  claude_code: '/opt/flux-tools/claude/bin/claude',
  codex: '/opt/flux-runtime/codex/bin/codex',
};

/** The CLI's own home inside a binding directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
export const CLIENT_DIRS: Record<RuntimeClient, string> = { claude_code: 'claude', codex: 'codex' };
/** The credential file each CLI writes in its home; checked by `stat` only, never opened. */
export const CREDENTIAL_FILES: Record<RuntimeClient, string> = { claude_code: '.credentials.json', codex: 'auth.json' };

export const CODEX_FILE_STORE = ['-c', 'cli_auth_credentials_store=file'] as const;

export const STATUS_TEMPLATES: Record<RuntimeClient, readonly string[]> = {
  claude_code: ['auth', 'status'],
  codex: [...CODEX_FILE_STORE, 'login', 'status'],
};

export const LOGOUT_TEMPLATES: Record<RuntimeClient, readonly string[]> = {
  claude_code: ['auth', 'logout'],
  codex: [...CODEX_FILE_STORE, 'logout'],
};

export const LOGIN_TEMPLATES: { [C in RuntimeClient]: Record<string, readonly string[]> } = {
  claude_code: {
    claude_account: ['auth', 'login'],
    console: ['auth', 'login', '--console'],
    sso: ['auth', 'login', '--sso'],
  },
  codex: {
    device_code: [...CODEX_FILE_STORE, 'login', '--device-auth'],
    api_key: [...CODEX_FILE_STORE, 'login', '--with-api-key'],
    access_token: [...CODEX_FILE_STORE, 'login', '--with-access-token'],
  },
};

/**
 * Every option the pinned `claude auth login --help` lists, and what the console does with it (F-022:
 * the console offers every method of the CLI's own login command). Claude Code 2.1.285 (2026-10-06)
 * lists `--claudeai` ("Use Claude subscription (default)": the Claude account method, which runs
 * without a flag as the decision's table says), `--console`, `--sso`, `--email` (pre-fills an address
 * on the vendor's page; not a method) and `-h, --help`. The opt-in contract check fails on any other
 * option, so a new method cannot appear without the console offering it.
 */
export const CLAUDE_LOGIN_HELP_OPTIONS: Record<string, { method: RuntimeLoginMethod | null; note: string }> = {
  '--claudeai': { method: 'claude_account', note: 'the default method; the console runs it as `claude auth login`' },
  '--console': { method: 'console', note: 'offered' },
  '--sso': { method: 'sso', note: 'offered' },
  '--email': { method: null, note: 'pre-fills an address on the sign-in page; not a sign-in method' },
  '--help': { method: null, note: 'help' },
  '-h': { method: null, note: 'help' },
};

/** The options a CLI help text lists (lines that start with a flag; `-h, --help` gives both). */
export function helpOptions(text: string): string[] {
  return [...text.matchAll(/^\s+(-[A-Za-z0-9-]+(?:,\s*-[A-Za-z0-9-]+)*)/gm)].flatMap((match) => match[1]!.split(/,\s*/));
}

/** Options of `claude auth login --help` that the console neither offers nor knows to be a non-method. */
export const unofferedLoginOptions = (text: string) => helpOptions(text).filter((option) => !Object.hasOwn(CLAUDE_LOGIN_HELP_OPTIONS, option));

export function loginArgv(client: RuntimeClient, method: RuntimeLoginMethod): readonly string[] {
  const argv = LOGIN_TEMPLATES[client][method];
  if (!argv) throw new Error('No login template for this client and method');
  return argv;
}

/** Inputs of a run command; every value was checked by the protocol before it reaches a template. */
/**
 * `model` is the assistant's chosen model (F-027 AST-11): an id the protocol checked against `MODEL_ID` (it starts with a
 * letter or digit, so it is never a flag). Claude Code takes it as `--model <alias>`, Codex as `-m <id>`; absent, the CLI
 * uses its account's default, as it did before the assistant had a choice.
 */
export interface RunTemplateInput { tools: readonly string[]; caps: RunCaps; mcpConfigPath: string; mcpUrl: string; brief: string; model?: string | undefined }

export const RUN_TEMPLATES: { [C in RuntimeClient]: (input: RunTemplateInput) => string[] } = {
  claude_code: ({ tools, caps, mcpConfigPath, brief, model }) => [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--restricted', '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--allowedTools', ...tools.map((tool) => `mcp__flux__${tool}`),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--max-turns', String(caps.maxTurns), ...(model ? ['--model', model] : []), '--append-system-prompt', brief,
  ],
  // Codex (T6 #281): every default-on feature of the pinned version that is not reviewed as harmless is off
  // (CODEX_FEATURE_REVIEW), web search is disabled, analytics is off (so no telemetry host is needed), and
  // Flux is the only MCP server, required, with the exact non-empty tool list. The prompt is read from stdin
  // (`-`); Flux's brief is a developer message, so Codex keeps its own instructions.
  codex: ({ tools, mcpUrl, brief, model }) => [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check',
    ...(model ? ['-m', model] : []), ...CODEX_FILE_STORE, ...codexRunOverrides(tools, mcpUrl, brief), '-',
  ],
};

/**
 * The pinned Codex's default-on features (codex-rs/features/src/lib.rs at rust-v0.160.1, c3e23d4, read
 * 2026-10-16) and what Flux does with each: `off` is passed as `-c features.<key>=false`; `kept` names why
 * it gives the run no tool, file, shell, network or sub-agent. `memories` is default-off and switched off
 * anyway (F-022). The contract test fails on a default-on feature this table does not name, so a new one
 * needs review before a new pin. `secret_auth_storage` is on only on Windows; the runtime is Linux. Features
 * the pinned `codex features list` shows as `removed` are not live and need no review. Checked against the
 * real pinned binary offline on 2026-10-16 (contract/check-codex.ts): every `off` feature is off except
 * `unified_exec` (`staysOn`), and `config/read` reflects the overrides.
 */
export const CODEX_FEATURE_REVIEW: Record<string, { action: 'off'; staysOn?: string } | { action: 'kept'; why: string }> = {
  daemon_auto_start: { action: 'off' }, shell_tool: { action: 'off' }, view_image: { action: 'off' }, sleep_tool: { action: 'off' },
  unified_exec: { action: 'off', staysOn: 'the pinned Codex keeps it on whatever -c says (only managed requirements disable it: codex-rs core/src/tools/spec_plan.rs); '
    + 'harmless here, because no command tool is registered at all while shell_tool is off (same function), and the JSONL check stops any command_execution' },
  unified_exec_tty: { action: 'off' }, shell_snapshot: { action: 'off' }, code_mode_host: { action: 'off' },
  write_stdin_approval: { action: 'off' }, hooks: { action: 'off' }, worktrees: { action: 'off' }, multi_agent: { action: 'off' },
  apps: { action: 'off' }, tool_suggest: { action: 'off' }, plugins: { action: 'off' }, in_app_browser: { action: 'off' },
  in_app_chat: { action: 'off' }, in_app_dictation: { action: 'off' }, in_app_local_automation: { action: 'off' }, in_app_updates: { action: 'off' },
  browser_use: { action: 'off' }, browser_use_full_cdp_access: { action: 'off' }, browser_use_external: { action: 'off' }, computer_use: { action: 'off' },
  remote_plugin: { action: 'off' }, plugin_sharing: { action: 'off' }, image_generation: { action: 'off' }, skill_mcp_dependency_install: { action: 'off' },
  skill_search: { action: 'off' }, mentions_v2: { action: 'off' }, guardian_approval: { action: 'off' }, goals: { action: 'off' },
  tool_call_mcp_elicitation: { action: 'off' }, auth_elicitation: { action: 'off' }, fast_mode: { action: 'off' }, realtime_conversation: { action: 'off' },
  workspace_dependencies: { action: 'off' }, memories: { action: 'off' },
  content_item_kinds: { action: 'kept', why: 'how message content is encoded for the model; no tool' },
  enable_request_compression: { action: 'kept', why: 'compresses requests to the vendor; no tool' },
  unbounded_connection_retries: { action: 'kept', why: 'retry policy only; the slot\'s no-event and wall-clock timeouts bound the run' },
  system_proxy_fallback: { action: 'kept', why: 'proxy discovery only; the slot sets HTTPS_PROXY to runtime-egress, its only route' },
  compaction_image_budget: { action: 'kept', why: 'context compaction budget; no tool' },
  guardian_reuse_parent_compaction: { action: 'kept', why: 'applies only to guardian reviews, which guardian_approval=false turns off' },
};

/** The `-c` overrides of a Codex run, in order. Values are TOML: strings as JSON strings, the tool list as an array. */
export function codexRunOverrides(tools: readonly string[], mcpUrl: string, brief: string): string[] {
  if (!tools.length) throw new Error('A Codex run needs a non-empty tool list');
  const features = Object.entries(CODEX_FEATURE_REVIEW).filter(([, review]) => review.action === 'off').map(([key]) => `features.${key}=false`);
  return [
    ...features, 'web_search="disabled"', 'analytics.enabled=false', 'check_for_update_on_startup=false',
    `developer_instructions=${JSON.stringify(brief)}`,
    `mcp_servers.flux.url=${JSON.stringify(mcpUrl)}`,
    'mcp_servers.flux.bearer_token_env_var="FLUX_RUN_TOKEN"',
    'mcp_servers.flux.required=true',
    `mcp_servers.flux.enabled_tools=${JSON.stringify(tools)}`,
  ].flatMap((value) => ['-c', value]);
}

/** Every flag (and the subcommand whose help lists it) that a template passes; for the contract check. */
export const TEMPLATE_FLAGS: { client: RuntimeClient; help: readonly string[]; flags: readonly string[]; optional?: readonly string[] }[] = [
  { client: 'claude_code', help: ['--help'], flags: ['--print', '--output-format', '--verbose', '--include-partial-messages', '--restricted', '--tools',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '--allowedTools', '--permission-mode', '--permission-prompts',
    '--no-session-persistence', '--max-turns', '--append-system-prompt', '--model'] },
  { client: 'claude_code', help: ['auth', 'login', '--help'], flags: ['--console', '--sso'] },
  { client: 'claude_code', help: ['auth', '--help'], flags: ['login', 'logout', 'status'] },
  { client: 'codex', help: ['exec', '--help'], flags: ['--json', '--ephemeral', '--ignore-user-config', '--sandbox', '--skip-git-repo-check', '--config', '--model'] },
  { client: 'codex', help: ['login', '--help'], flags: ['--device-auth', '--with-api-key', 'status'], optional: ['--with-access-token'] },
  { client: 'codex', help: ['--help'], flags: ['login', 'logout', 'exec', 'app-server', 'features', '--config'] },
];

/**
 * The CLI's whole environment: built here, never inherited. The supervisor's own variables (its slot
 * secret among them) never reach a CLI; nor does anything from a request except, for a run, the run
 * token in `FLUX_RUN_TOKEN` (T5).
 */
export function cliEnvironment(client: RuntimeClient, bindingDir: string, egressHost: string, extra: Record<string, string> = {}): Record<string, string> {
  const proxy = `http://${egressHost}:3128`;
  const base: Record<string, string> = {
    PATH: '/opt/flux-tools/claude/bin:/opt/flux-runtime/codex/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: `${bindingDir}/home`,
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    HTTPS_PROXY: proxy, https_proxy: proxy,
    NO_PROXY: egressHost, no_proxy: egressHost,
  };
  const own: Record<RuntimeClient, Record<string, string>> = {
    claude_code: {
      CLAUDE_CONFIG_DIR: `${bindingDir}/${CLIENT_DIRS.claude_code}`,
      DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
    codex: { CODEX_HOME: `${bindingDir}/${CLIENT_DIRS.codex}` },
  };
  return { ...base, ...own[client], ...extra };
}
