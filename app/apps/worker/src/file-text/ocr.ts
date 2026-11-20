import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanText } from './clean.js';
import type { Extracted } from './text.js';

/**
 * OCR of one picture (C-70, #1575), in the sandboxed child (child.ts) after it confined itself: Tesseract 5 as the pinned WebAssembly build
 * of tesseract.js-core (single-threaded, SIMD, LSTM only; no worker thread, no network, no file but its own and the language data), with
 * the pinned Polish and English data (`4.0.0_best_int`). The picture is PNG, JPEG, WebP or GIF (Leptonica reads the first frame), already
 * within the pixel bounds the parent checked. Its text is kept only when Tesseract is confident enough and found enough words: a photo of
 * a face or a landscape gives a few stray letters at low confidence, never text to keep.
 */
export interface OcrLimits { core: string; pol: string; eng: string; confidence: number; words: number; chars: number }

interface TessApi {
  Init(dataPath: string, languages: string): number;
  SetImageFile(exif: number, angle: number): number;
  Recognize(monitor: null): number;
  GetUTF8Text(): string;
  MeanTextConf(): number;
  End(): void;
}
interface TessModule { FS: { writeFile(path: string, data: Uint8Array): void }; TessBaseAPI: new () => TessApi }

/** Words of three letters or more (any script's letters), the measure of "enough words". */
const WORD = /\p{L}{3,}/gu;

export async function recognise(bytes: Uint8Array, limits: OcrLimits): Promise<Extracted> {
  const factory = (await import(join(limits.core, 'tesseract-core-simd-lstm.js'))).default as (options: Record<string, unknown>) => Promise<TessModule>;
  const tess = await factory({ wasmBinary: readFileSync(join(limits.core, 'tesseract-core-simd-lstm.wasm')), print: () => undefined, printErr: () => undefined });
  tess.FS.writeFile('/pol.traineddata', gunzipSync(readFileSync(join(limits.pol, '4.0.0_best_int', 'pol.traineddata.gz'))));
  tess.FS.writeFile('/eng.traineddata', gunzipSync(readFileSync(join(limits.eng, '4.0.0_best_int', 'eng.traineddata.gz'))));
  const api = new tess.TessBaseAPI();
  if (api.Init('/', 'pol+eng') !== 0) return { ok: false, reason: 'unreadable' };
  tess.FS.writeFile('/input', bytes);
  if (api.SetImageFile(1, 0) === 1) return { ok: false, reason: 'unreadable' };
  api.Recognize(null);
  const text = cleanText(api.GetUTF8Text().slice(0, limits.chars * 2)).slice(0, limits.chars);
  const confidence = api.MeanTextConf();
  api.End();
  if (confidence < limits.confidence || (text.match(WORD)?.length ?? 0) < limits.words) return { ok: false, reason: 'empty' };
  return { ok: true, segments: [{ text }] };
}
