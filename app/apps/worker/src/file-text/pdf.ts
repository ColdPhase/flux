import { cleanText } from './clean.js';
import { encodePng, greyIfGrey, scaleDown, toGrey, toPixels, type DecodedPicture } from './png.js';
import type { Extracted, PagePicture } from './text.js';

/**
 * The text layer of a PDF (C-63, #1382), read by PDF.js 6.5.438's legacy build (the version the preview uses, #1349) in this process: no
 * worker (the fake worker runs in this thread), no `eval`, no fonts loaded, no images decoded, no network. A scan has no text layer and
 * is `empty`; a password-protected file is `encrypted`; anything PDF.js cannot parse is `unreadable`. At most `pages` pages are read, and
 * reading stops when `chars` characters are found; the parent kills this process at its time and memory limits.
 */
export interface PdfLimits { pages: number; chars: number; pictures?: PictureLimits }
export interface PictureLimits { pages: number; side: number; pixels: number; pictureBytes: number; totalBytes: number; untilMs: number;
  /** With OCR on (C-70): each page is also given grey, at most this many px on its long side, for OCR alone (never stored). */
  ocrSide?: number }

interface TextItem { str?: string; hasEOL?: boolean }
interface PdfPage {
  getTextContent(options?: Record<string, unknown>): Promise<{ items: TextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(id: string, callback: (value: unknown) => void): void };
  cleanup(): void;
}
interface PdfDocument { numPages: number; getPage(number: number): Promise<PdfPage> }
interface PdfTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
interface PdfJs { getDocument(options: Record<string, unknown>): PdfTask; OPS: Record<string, number> }

export async function extractPdf(bytes: Uint8Array, limits: PdfLimits, pdfjsDirectory: string): Promise<Extracted> {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) return { ok: false, reason: 'unreadable' };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJs;
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, enableXfa: false,
    disableAutoFetch: true, disableStream: true, stopAtErrors: false, maxImageSize: 1, verbosity: 0,
    cMapUrl: `${pdfjsDirectory}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDirectory}/standard_fonts/`,
  });
  let document: PdfDocument;
  try { document = await task.promise; }
  catch (error) {
    const name = (error as { name?: string }).name ?? '';
    return { ok: false, reason: name === 'PasswordException' ? 'encrypted' : 'unreadable' };
  }
  const segments: { text: string; page: number }[] = [];
  let found = 0;
  const last = Math.min(document.numPages, limits.pages);
  for (let number = 1; number <= last && found < limits.chars; number++) {
    let page: PdfPage;
    try { page = await document.getPage(number); } catch { continue; }
    try {
      const { items } = await page.getTextContent({ includeMarkedContent: false });
      const lines: string[] = [];
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        lines.push(item.str);
        if (item.hasEOL) lines.push('\n');
      }
      const text = cleanText(lines.join(''));
      if (text) { segments.push({ text, page: number }); found += text.length; }
    } catch { /* one unreadable page does not hide the others */ }
    page.cleanup();
  }
  await task.destroy().catch(() => undefined);
  if (segments.length) return { ok: true, segments, pages: document.numPages };
  // No text layer (C-69, #1557): a scan, an exported map, slides saved as pictures. A model that sees pictures is given its pages instead.
  const pictures = limits.pictures ? await pagePictures(pdfjs, bytes, limits.pictures, pdfjsDirectory).catch(() => []) : [];
  return { ok: false, reason: 'empty', ...(pictures.length ? { pictures } : {}) };
}

/**
 * The pictures of a PDF without text (C-69): of each of its first pages, the largest picture drawn on it (a scan or an export is one picture
 * a page), decoded by PDF.js in this sandboxed process (only now: the text read decodes none), scaled down and written as a PNG. A page with
 * no picture, or one too large to decode, has none; the pictures stop at their total bound.
 */
async function pagePictures(pdfjs: PdfJs, bytes: Uint8Array, limits: PictureLimits, pdfjsDirectory: string): Promise<PagePicture[]> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, enableXfa: false,
    disableAutoFetch: true, disableStream: true, stopAtErrors: false, maxImageSize: limits.pixels, isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false, verbosity: 0, cMapUrl: `${pdfjsDirectory}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${pdfjsDirectory}/standard_fonts/`,
    wasmUrl: `${pdfjsDirectory}/wasm/`,
  });
  const pictures: PagePicture[] = [];
  try {
    const document = await task.promise;
    const painted = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObject]);
    let total = 0;
    let ocrTotal = 0;
    for (let number = 1; number <= Math.min(document.numPages, limits.pages); number++) {
      // The pages made so far are kept rather than lost to the parent's time bound (`performance.now()` counts from this process's start).
      if (performance.now() > limits.untilMs) break;
      let page: PdfPage;
      try { page = await document.getPage(number); } catch { continue; }
      try {
        const { fnArray, argsArray } = await page.getOperatorList();
        let largest: DecodedPicture | null = null;
        for (let index = 0; index < fnArray.length; index++) {
          if (!painted.has(fnArray[index]!)) continue;
          const reference = argsArray[index]?.[0];
          const decoded = (typeof reference === 'string' ? await objectOf(page, reference) : reference) as DecodedPicture | null;
          if (decoded?.data && decoded.width * decoded.height > (largest ? largest.width * largest.height : 0)) largest = decoded;
        }
        const pixels = largest ? toPixels(largest) : null;
        if (pixels) {
          const png = encodePng(scaleDown(greyIfGrey(pixels), limits.side));
          if (png.length <= limits.pictureBytes && total + png.length <= limits.totalBytes) {
            total += png.length;
            const scaled = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
            // The page OCR reads: bounded like a stored picture, a page over it is simply not read by OCR.
            const grey = limits.ocrSide ? encodePng(scaleDown(toGrey(pixels), limits.ocrSide)) : null;
            const ocr = grey && grey.length <= OCR_PAGE_BYTES && ocrTotal + grey.length <= limits.totalBytes ? grey.toString('base64') : null;
            if (ocr) ocrTotal += grey!.length;
            pictures.push({ page: number, ...scaled, png: png.toString('base64'), ...(ocr ? { ocr } : {}) });
          }
        }
      } catch { /* one page that cannot be drawn does not hide the others */ }
      page.cleanup();
    }
  } finally { await task.destroy().catch(() => undefined); }
  return pictures;
}

/** The most one page's grey PNG for OCR may be (C-70): a dense A4 page at 300 dpi is about 0.4 MB. */
const OCR_PAGE_BYTES = 4 * 1024 * 1024;

/** A decoded picture of the page, or null when PDF.js has none under that name in time. */
function objectOf(page: PdfPage, id: string): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5_000);
    try { page.objs.get(id, (value) => { clearTimeout(timer); resolve(value); }); } catch { clearTimeout(timer); resolve(null); }
  });
}
