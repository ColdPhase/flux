import { cleanText } from './clean.js';
import type { Extracted } from './text.js';

/**
 * The text layer of a PDF (C-63, #1382), read by PDF.js 6.5.438's legacy build (the version the preview uses, #1349) in this process: no
 * worker (the fake worker runs in this thread), no `eval`, no fonts loaded, no images decoded, no network. A scan has no text layer and
 * is `empty`; a password-protected file is `encrypted`; anything PDF.js cannot parse is `unreadable`. At most `pages` pages are read, and
 * reading stops when `chars` characters are found; the parent kills this process at its time and memory limits.
 */
export interface PdfLimits { pages: number; chars: number }

interface TextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(options?: Record<string, unknown>): Promise<{ items: TextItem[] }>; cleanup(): void }
interface PdfDocument { numPages: number; getPage(number: number): Promise<PdfPage> }
interface PdfTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
interface PdfJs { getDocument(options: Record<string, unknown>): PdfTask }

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
  return segments.length ? { ok: true, segments, pages: document.numPages } : { ok: false, reason: 'empty' };
}
