import type { RuntimeManagerClient } from './manager-api.js';

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
    async release(slot: string, bindingId: string): Promise<PortCall<{ dataEmpty: boolean; logoutFailed: boolean }>> {
      const answer = await client.request(slot, { kind: 'release', bindingId });
      if (!answer.ok) return answer;
      if (answer.result.kind !== 'release') return { ok: false, code: 'protocol' };
      const { dataEmpty, logout } = answer.result;
      return { ok: true, value: { dataEmpty, logoutFailed: Object.values(logout).some((step) => step !== 'ok') } };
    },
  };
}
