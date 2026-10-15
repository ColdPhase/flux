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

const CODEX_FILE_STORE = ['-c', 'cli_auth_credentials_store=file'];

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
export interface RunTemplateInput { tools: readonly string[]; caps: RunCaps; mcpConfigPath: string; mcpUrl: string; brief: string }

export const RUN_TEMPLATES: { [C in RuntimeClient]: (input: RunTemplateInput) => string[] } = {
  claude_code: ({ tools, caps, mcpConfigPath, brief }) => [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--restricted', '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--allowedTools', ...tools.map((tool) => `mcp__flux__${tool}`),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--no-session-persistence', '--max-turns', String(caps.maxTurns), '--append-system-prompt', brief,
  ],
  codex: ({ tools, mcpUrl }) => [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check',
    ...CODEX_FILE_STORE,
    '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.apps=false',
    '-c', 'features.multi_agent=false', '-c', 'features.skill_mcp_dependency_install=false',
    '-c', 'web_search=disabled', '-c', 'tools.web_search=false', '-c', 'tools.view_image=false',
    '-c', 'features.hooks=false', '-c', 'features.goals=false',
    '-c', 'features.remote_plugin=false', '-c', 'features.memories=false',
    '-c', `mcp_servers.flux.url=${mcpUrl}`,
    '-c', 'mcp_servers.flux.bearer_token_env_var=FLUX_RUN_TOKEN',
    '-c', 'mcp_servers.flux.required=true',
    '-c', `mcp_servers.flux.enabled_tools=${JSON.stringify(tools)}`,
  ],
};

/** Every flag (and the subcommand whose help lists it) that a template passes; for the contract check. */
export const TEMPLATE_FLAGS: { client: RuntimeClient; help: readonly string[]; flags: readonly string[]; optional?: readonly string[] }[] = [
  { client: 'claude_code', help: ['--help'], flags: ['--print', '--output-format', '--verbose', '--include-partial-messages', '--restricted', '--tools',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '--allowedTools', '--permission-mode', '--permission-prompts',
    '--no-session-persistence', '--max-turns', '--append-system-prompt'] },
  { client: 'claude_code', help: ['auth', 'login', '--help'], flags: ['--console', '--sso'] },
  { client: 'claude_code', help: ['auth', '--help'], flags: ['login', 'logout', 'status'] },
  { client: 'codex', help: ['exec', '--help'], flags: ['--json', '--ephemeral', '--ignore-user-config', '--sandbox', '--skip-git-repo-check', '--config'] },
  { client: 'codex', help: ['login', '--help'], flags: ['--device-auth', '--with-api-key', 'status'], optional: ['--with-access-token'] },
  { client: 'codex', help: ['--help'], flags: ['login', 'logout', 'exec', '--config'] },
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
