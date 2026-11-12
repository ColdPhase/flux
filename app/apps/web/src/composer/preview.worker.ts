import { parsePreview, transferablesOf, type ParsedFormat } from './previewParse';

// The file preview's parser (C-58, #1252): decodes and parses off the page's thread, then hands back one string and typed arrays.
interface Scope { onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer; format: ParsedFormat }>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void }
const scope = self as unknown as Scope;
scope.onmessage = (event) => {
  try {
    const model = parsePreview(new Uint8Array(event.data.bytes), event.data.format);
    scope.postMessage({ model }, transferablesOf(model));
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  }
};
