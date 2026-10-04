import * as Y from 'yjs';
import { writeVarUint } from 'lib0/encoding';

// Adversarial wire fixtures use exported constructors/encoder methods only.
export function item(client, clock, text, { origin = null, rightOrigin = null, parent = 'body' } = {}) {
  const reference = (value) => value && new Y.ID(value.client, value.clock);
  return new Y.Item(new Y.ID(client, clock), null, reference(origin), null,
    reference(rightOrigin), parent, null, new Y.ContentString(text));
}
export function wire(structs = [], deletes = []) {
  const encoder = new Y.UpdateEncoderV1();
  const groups = new Map();
  for (const struct of structs) {
    const group = groups.get(struct.id.client) ?? [];
    group.push(struct); groups.set(struct.id.client, group);
  }
  writeVarUint(encoder.restEncoder, groups.size);
  for (const [client, group] of [...groups].sort((a, b) => b[0] - a[0])) {
    group.sort((a, b) => a.id.clock - b.id.clock);
    writeVarUint(encoder.restEncoder, group.length); encoder.writeClient(client);
    writeVarUint(encoder.restEncoder, group[0].id.clock);
    for (const struct of group) struct.write(encoder, 0);
  }
  const ranges = new Map();
  for (const range of deletes) {
    const group = ranges.get(range.client) ?? [];
    group.push(range); ranges.set(range.client, group);
  }
  writeVarUint(encoder.restEncoder, ranges.size);
  for (const [client, group] of [...ranges].sort((a, b) => b[0] - a[0])) {
    encoder.resetDsCurVal(); writeVarUint(encoder.restEncoder, client);
    writeVarUint(encoder.restEncoder, group.length);
    for (const range of group) { encoder.writeDsClock(range.clock); encoder.writeDsLen(range.length); }
  }
  return encoder.toUint8Array();
}
