import { GlobalWorkerOptions, RenderingCancelledException, TextLayer, getDocument, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import './viewer.css';
import { PDF_FRAME, externalLink, type ViewerMessage } from './protocol';

// The PDF viewer frame (C-60, #1350). Flux's page frames this page with `sandbox="allow-scripts"` and the page's own policy, so it runs
// in an opaque origin with no network, no storage and no way to navigate or open anything. It draws the file's pages with PDF.js,
// lays the text over them, and turns each link annotation into a button. Pressing one never navigates: an address (http or https only)
// goes to Flux's page, which shows it and opens it in a new tab only when the person presses Open; a place in the document scrolls here.

const GAP = 12;
const LARGEST_SCALE = 4;
/** A page is never drawn wider than this, however wide the viewer is: a reading width on a large screen. */
const WIDEST_PAGE = 960;
/** A hostile file can declare millions of pages; the viewer draws at most this many. */
const MOST_PAGES = 5000;
/** Pixels in one drawn page, so a page the size of a poster does not take the tab's memory (device pixels). */
const MOST_PIXELS = 16 * 1024 * 1024;
/** What PDF.js is told to do for a page it has not measured yet: a letter page. */
const LETTER = { width: 612, height: 792 };

const say = (message: ViewerMessage) => parent.postMessage(message, '*');

interface View {
  index: number;
  element: HTMLDivElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  links: HTMLDivElement;
  /** The page's size at scale 1, once PDF.js has read it. */
  size: { width: number; height: number } | null;
  scale: number;
  /** In or near the scroller's view: the page is drawn while it is, and released when it is not. */
  near: boolean;
  active: boolean;
  /** Bumped when the page stops being drawn, so a drawing that finishes late is thrown away. */
  turn: number;
  task: RenderTask | null;
  layer: TextLayer | null;
}

const scroller = document.getElementById('scroller') as HTMLDivElement;
const pages = document.getElementById('pages') as HTMLDivElement;
let pdf: PDFDocumentProxy | null = null;
const views: View[] = [];
let announced = false;

function start(bytes: Uint8Array) {
  void open(bytes).catch(() => say({ frame: PDF_FRAME, type: 'failed', reason: 'damaged' }));
}

async function open(bytes: Uint8Array) {
  const worker = new PdfWorker();
  // A worker that cannot start would leave the document loading for ever.
  worker.addEventListener('error', () => { if (!pdf) say({ frame: PDF_FRAME, type: 'failed', reason: 'damaged' }); });
  GlobalWorkerOptions.workerPort = worker;
  const loading = getDocument({
    data: bytes,
    // Nothing the file says is fetched or run: PDF.js runs a file's scripts only for a viewer that asks (this one does not), no XFA
    // forms, no fonts or maps by address, no drawing in another thread, and no image of more than 2^25 pixels.
    enableXfa: false, useWorkerFetch: false, disableWorkerRendering: true, isOffscreenCanvasSupported: false, maxImageSize: 1 << 25, verbosity: 0,
  });
  try { pdf = await loading.promise; } catch (error) {
    say({ frame: PDF_FRAME, type: 'failed', reason: error instanceof Error && error.name === 'PasswordException' ? 'password' : 'damaged' });
    return;
  }
  const count = Math.min(pdf.numPages, MOST_PAGES);
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const view = views[Number((entry.target as HTMLElement).dataset.index)];
      if (!view) continue;
      view.near = entry.isIntersecting;
      if (view.near) activate(view); else release(view);
    }
  }, { root: scroller, rootMargin: '100% 0px' });
  for (let index = 0; index < count; index++) {
    const element = document.createElement('div');
    element.className = 'page';
    element.dataset.index = String(index);
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', `Page ${index + 1} of ${count}`);
    const canvas = document.createElement('canvas');
    // A canvas starts at 300 x 150 pixels: empty until its page is drawn, and again when it is released.
    canvas.width = 0;
    canvas.height = 0;
    canvas.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'textLayer';
    const links = document.createElement('div');
    links.className = 'links';
    element.append(canvas, text, links);
    pages.append(element);
    views.push({ index, element, canvas, text, links, size: null, scale: 1, near: false, active: false, turn: 0, task: null, layer: null });
  }
  layout();
  new ResizeObserver(() => relayout()).observe(scroller);
  for (const view of views) observer.observe(view.element);
  void measureAll();
}

/** Every page's size at scale 1, read in the background so the scroll height settles; the pages in view are drawn meanwhile. */
async function measureAll() {
  for (const view of views) {
    if (!view.size) await measure(view.index);
    if (view.index % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function measure(index: number): Promise<PDFPageProxy | null> {
  const view = views[index];
  if (!pdf || !view) return null;
  const page = await pdf.getPage(index + 1);
  if (!view.size) {
    const viewport = page.getViewport({ scale: 1 });
    view.size = { width: viewport.width, height: viewport.height };
    fit(view);
  }
  return page;
}

/** The page's size on screen: the viewer's width less the gaps (at most a reading width), whatever the page's own size. */
function fit(view: View) {
  const size = view.size ?? views[0]?.size ?? LETTER;
  const room = Math.min(WIDEST_PAGE, Math.max(120, scroller.clientWidth - 2 * GAP));
  view.scale = Math.min(LARGEST_SCALE, room / size.width);
  view.element.style.width = `${Math.floor(size.width * view.scale)}px`;
  view.element.style.height = `${Math.floor(size.height * view.scale)}px`;
}

function layout() {
  if (scroller.clientWidth) for (const view of views) fit(view);
}

let relayoutTimer = 0;
/** The viewer's width changed (a window, a phone turned): size every page again and draw those in view at the new scale. */
function relayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = window.setTimeout(() => {
    const before = views.map((view) => view.scale);
    layout();
    for (const view of views) {
      if (view.active && Math.abs(view.scale - before[view.index]!) > 0.001) release(view);
      if (view.near) activate(view);
    }
  }, 120);
}

function activate(view: View) {
  if (view.active || !scroller.clientWidth) return;
  view.active = true;
  const turn = ++view.turn;
  void draw(view, turn).catch((error) => {
    if (error instanceof RenderingCancelledException || turn !== view.turn) return;
    if (view.index === 0 && !announced) say({ frame: PDF_FRAME, type: 'failed', reason: 'damaged' });
  });
}

function release(view: View) {
  if (!view.active) return;
  view.active = false;
  view.turn++;
  view.task?.cancel();
  view.task = null;
  view.layer?.cancel();
  view.layer = null;
  view.canvas.width = 0;
  view.canvas.height = 0;
  view.text.replaceChildren();
  view.links.replaceChildren();
}

async function draw(view: View, turn: number) {
  const page = await measure(view.index);
  if (!page || turn !== view.turn) return;
  const viewport = page.getViewport({ scale: view.scale });
  let output = Math.min(window.devicePixelRatio || 1, 2);
  while (output > 1 && viewport.width * viewport.height * output * output > MOST_PIXELS) output -= 0.25;
  view.canvas.width = Math.max(1, Math.floor(viewport.width * output));
  view.canvas.height = Math.max(1, Math.floor(viewport.height * output));
  view.canvas.style.width = `${Math.floor(viewport.width)}px`;
  view.canvas.style.height = `${Math.floor(viewport.height)}px`;
  view.element.style.setProperty('--total-scale-factor', String(viewport.scale));
  const task = page.render({ canvas: view.canvas, viewport, transform: output === 1 ? undefined : [output, 0, 0, output, 0, 0] });
  view.task = task;
  await task.promise;
  if (turn !== view.turn) return;
  if (!announced) { announced = true; say({ frame: PDF_FRAME, type: 'drawn' }); }
  const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: view.text, viewport });
  view.layer = layer;
  await layer.render().catch(() => undefined);
  if (turn !== view.turn) return;
  const annotations = await page.getAnnotations({ intent: 'display' });
  if (turn !== view.turn) return;
  view.links.replaceChildren(...annotations.flatMap((annotation) => linkButton(annotation, viewport) ?? []));
}

interface Annotation { subtype?: string; rect?: number[]; url?: unknown; dest?: unknown; action?: unknown }

/**
 * A link annotation as a button over its area, or nothing. Only three things are ever offered, and each is checked here and again by
 * Flux's page: an http or https address, a place in this document, and the four named page actions. Everything else a link can do
 * (a script, another file, a form, a layer switch, any other scheme) is not drawn at all.
 */
function linkButton(annotation: Annotation, viewport: { convertToViewportPoint(x: number, y: number): number[] }): HTMLButtonElement | null {
  if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) return null;
  const address = externalLink(annotation.url);
  const named = typeof annotation.action === 'string' && ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(annotation.action) ? annotation.action : null;
  const place = annotation.dest;
  const inside = typeof place === 'string' || Array.isArray(place);
  if (!address && !named && !inside) return null;
  const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0]!, annotation.rect[1]!) as [number, number];
  const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2]!, annotation.rect[3]!) as [number, number];
  const [left, top, right, bottom] = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  const button = document.createElement('button');
  button.type = 'button';
  button.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
  if (address) {
    button.title = address;
    button.setAttribute('aria-label', `Link to ${address}`);
    button.addEventListener('click', () => say({ frame: PDF_FRAME, type: 'link', url: address }));
  } else {
    button.setAttribute('aria-label', named ? ({ NextPage: 'Next page', PrevPage: 'Previous page', FirstPage: 'First page', LastPage: 'Last page' } as Record<string, string>)[named]! : 'Go to a place in this document');
    button.addEventListener('click', () => void (named ? goToNamed(named) : goToPlace(place)));
  }
  return button;
}

/** The page in view: the last one that starts above the scroller's top edge. */
function currentPage(): number {
  let found = 0;
  for (const view of views) if (view.element.offsetTop - GAP <= scroller.scrollTop + 1) found = view.index; else break;
  return found;
}

async function goToNamed(action: string) {
  const last = views.length - 1;
  await scrollToPage(action === 'FirstPage' ? 0 : action === 'LastPage' ? last : action === 'NextPage' ? currentPage() + 1 : currentPage() - 1, 0);
}

/** A destination is a name or an explicit array: the page (a reference or a number), a view type and its coordinates. Anything else is ignored. */
async function goToPlace(place: unknown) {
  if (!pdf) return;
  const explicit = typeof place === 'string' ? await pdf.getDestination(place) : place;
  if (!Array.isArray(explicit)) return;
  const target = explicit[0] as unknown;
  let index: number | null = null;
  if (typeof target === 'number' && Number.isInteger(target)) index = target;
  else if (typeof target === 'object' && target !== null) index = await pdf.getPageIndex(target as { num: number; gen: number }).catch(() => null);
  if (index === null || index < 0 || index >= views.length) return;
  const kind = (explicit[1] as { name?: string } | null)?.name;
  const y = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
  let offset = 0;
  if (typeof y === 'number' && Number.isFinite(y)) {
    const page = await measure(index);
    const view = views[index]!;
    if (page) offset = Math.max(0, Math.min(view.element.clientHeight - 1, page.getViewport({ scale: view.scale }).convertToViewportPoint(0, y)[1]));
  }
  await scrollToPage(index, offset);
}

/** Scrolls to a page and a distance down it. Pages before it are measured first, so what is above does not move it afterwards. */
async function scrollToPage(index: number, offset: number) {
  const target = Math.max(0, Math.min(views.length - 1, index));
  for (let i = 0; i <= target; i++) if (!views[i]!.size) await measure(i);
  layout();
  scroller.scrollTop = views[target]!.element.offsetTop - GAP + offset;
}

// Flux's page is the only one that may talk to this one, and only once, with the file.
let opened = false;
addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { frame?: unknown; type?: unknown; bytes?: unknown } | null;
  if (opened || event.source !== parent || parent === window) return;
  if (!data || data.frame !== PDF_FRAME || data.type !== 'open' || !(data.bytes instanceof ArrayBuffer)) return;
  opened = true;
  start(new Uint8Array(data.bytes));
});
if (parent !== window) say({ frame: PDF_FRAME, type: 'ready' });
