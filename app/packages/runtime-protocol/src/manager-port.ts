import type { ClientStatus, StepOutcome } from './frames.js';
import type { RuntimeManagerClient } from './manager-api.js';
import type { RuntimeClient } from './names.js';

// The API's and worker's view of runtime-manager as the use cases need it: structurally the core port
// `RuntimeManagerPort` (@flux/core), kept here so this package stays free of application packages.

export type PortCall<T> = { ok: true; value: T } | { ok: false; code: string };
export type PortSighting =
  | { slot: string; reachable: true; bootId: string; bindings: string[]; other: number }
  | { slot: string; reachable: false; error: string };

export function runtimeManagerPort(client: RuntimeManagerClient) {
  return {
    async slots(): Promise<PortCall<PortSighting[]>> {
      const answer = await client.slots();
      if (!answer.ok) return answer;
      return { ok: true, value: answer.slots.map((entry): PortSighting => entry.reachable
        ? { slot: entry.slot, reachable: true, bootId: entry.report.bootId, bindings: entry.report.data.bindings, other: entry.report.data.other }
        : { slot: entry.slot, reachable: false, error: entry.error }) };
    },
    async bind(slot: string, bindingId: string): Promise<PortCall<void>> {
      const answer = await client.request(slot, { kind: 'bind', bindingId });
      return answer.ok ? { ok: true, value: undefined } : answer;
    },
    /** The CLI's own status (`claude auth status`), reduced in the slot to display facts. */
    async status(slot: string, bindingId: string, cli: RuntimeClient, bootId: string): Promise<PortCall<ClientStatus & { bootId: string }>> {
      const answer = await client.request(slot, { kind: 'status', bindingId, client: cli, bootId });
      if (!answer.ok) return answer;
      if (answer.result.kind !== 'status' || !('client' in answer.result)) return { ok: false, code: 'protocol' };
      return { ok: true, value: { ...answer.result.client, bootId: answer.bootId } };
    },
    /** Sign out: the CLI's own logout first, then the supervisor deletes that CLI's files either way. */
    async logout(slot: string, bindingId: string, cli: RuntimeClient, bootId: string): Promise<PortCall<{ logout: StepOutcome; bootId: string }>> {
      const answer = await client.request(slot, { kind: 'logout', bindingId, client: cli, bootId });
      if (!answer.ok) return answer;
      if (answer.result.kind !== 'logout') return { ok: false, code: 'protocol' };
      return { ok: true, value: { logout: answer.result.logout, bootId: answer.bootId } };
    },
    async release(slot: string, bindingId: string): Promise<PortCall<{ dataEmpty: boolean; logoutFailed: boolean }>> {
      const answer = await client.request(slot, { kind: 'release', bindingId });
      if (!answer.ok) return answer;
      if (answer.result.kind !== 'release') return { ok: false, code: 'protocol' };
      const { dataEmpty, logout } = answer.result;
      return { ok: true, value: { dataEmpty, logoutFailed: Object.values(logout).some((step) => step !== 'ok') } };
    },
  };
}
