import { EDITING_LIMITS } from '@flux/contracts';
import { EditingOutputError } from './output.js';
/** Count the exact JSON wire/text size without first allocating an escaped copy. */
export function editingJSONSize(value: unknown) {
  let bytes = 0, units = 0;
  const add = (wire: number, text = wire) => {
    bytes += wire; units += text;
    if (bytes > EDITING_LIMITS.assemblyBytes) throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
  };
  function string(text: string) {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const point = text.charCodeAt(i);
      if (point === 34 || point === 92 || [8, 9, 10, 12, 13].includes(point)) add(2);
      else if (point < 32) add(6);
      else if (point < 128) add(1);
      else if (point < 2048) add(2, 1);
      else if (point >= 0xd800 && point <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4, 2); i++; } else add(6);
      } else if (point >= 0xdc00 && point <= 0xdfff) add(6);
      else add(3, 1);
    }
  }
  function visit(child: unknown) {
    if (child === null || child === undefined) add(4);
    else if (typeof child === 'string') string(child);
    else if (typeof child === 'boolean') add(child ? 4 : 5);
    else if (typeof child === 'number') add(Number.isFinite(child) ? String(child).length : 4);
    else if (child instanceof Date) { if (Number.isFinite(child.getTime())) string(child.toISOString()); else add(4); }
    else if (Array.isArray(child)) {
      add(2); for (let i = 0; i < child.length; i++) { if (i) add(1); visit(child[i]); }
    } else if (child && typeof child === 'object' && Object.getPrototypeOf(child) === Object.prototype) {
      add(2); let first = true;
      for (const [key, nested] of Object.entries(child)) {
        if (nested === undefined) continue;
        if (!first) add(1); first = false; string(key); add(1); visit(nested);
      }
    } else throw new EditingOutputError('EDITING_OUTPUT_CAPACITY');
  }
  visit(value); return { bytes, textBytes: units * 2 };
}
