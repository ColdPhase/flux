import { RUNTIME_CLIENTS, type RuntimeClient, type StepOutcome } from '@flux/runtime-protocol';

/**
 * One machine-readable line per client the slot found no CLI and no files for during a release. `./flux runtime
 * purge` hands these (binding, client) pairs to the database, which confirms them only against its durable client
 * history (#480). The format is parsed by `runtime_sign_out` in the launcher and nothing else.
 */
export function notInstalledMarkers(bindingId: string, logout: Record<RuntimeClient, StepOutcome>): string[] {
  return RUNTIME_CLIENTS.filter((client) => logout[client] === 'not_installed').map((client) => `FLUX_RUNTIME_NOT_INSTALLED ${bindingId} ${client}`);
}
