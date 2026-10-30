import { coworkHostInstructions, coworkHostUrl, type CoworkHostBinding } from '../../../tooling/cowork.js';

/** Exact inline first-login argv used by cmd_cowork; no mcp add or registration/callback override. */
export function coworkProductionLogin(binding: CoworkHostBinding) {
  return ['-c', `mcp_servers.flux.url=${JSON.stringify(coworkHostUrl(binding))}`, '-c', 'mcp_servers.flux.required=true', 'mcp', 'login', 'flux'];
}

/** Test-side copy of the supplied host action argv; never append fixture OAuth/backend overrides. */
export function coworkProductionInvoke(binding: CoworkHostBinding, action: 'start' | 'resume') {
  if (action === 'resume' && (!binding.threadId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(binding.threadId)))
    throw new Error('Resume requires this isolated action’s own native thread.');
  return ['exec', '--ignore-user-config', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '-c', `mcp_servers.flux.url=${JSON.stringify(coworkHostUrl(binding))}`, '-c', 'mcp_servers.flux.required=true',
    '-c', 'mcp_servers.flux.default_tools_approval_mode="approve"',
    '-c', `developer_instructions=${JSON.stringify(coworkHostInstructions(binding, action))}`,
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
    ...(action === 'resume' ? ['resume', binding.threadId!] : []),
    'Follow the current Flux server playbook for this bound host action.'];
}
