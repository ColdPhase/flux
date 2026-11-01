#!/usr/bin/env node
// Generates the Starlight pages of the documentation site from the repository's own Markdown.
//
// The repository files stay the only source: this script copies the user-facing documents listed in
// PAGES into src/content/docs (git-ignored), takes the title from each document's first heading,
// rewrites links between included documents to site routes and every other repository link to
// GitHub, and copies the images they use. Internal agent, process and design documents are not
// listed, so they are not published. Change the prose in docs/ or README.md, never here.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(SITE, '..');
const BASE = '/flux';
const REPO = 'https://github.com/ColdPhase/flux';
const OUT = join(SITE, 'src/content/docs');
const MEDIA = join(SITE, 'public/media');

/**
 * Every published page. `from` is a repository path; `sections` publishes only those headings of it
 * (with everything under them); `title` overrides the document's first heading; `tocDepth` limits the page's table
 * of contents to headings up to that level.
 */
export const PAGES = [
  { route: '', from: 'README.md', sections: ['Highlights', 'Why Flux', 'Project status'], splash: true },
  { route: 'start/quick-start', from: 'README.md', sections: ['Quick start'], title: 'Quick start' },
  { route: 'start/connect-your-agent', from: 'README.md', sections: ['Connect your own agent'], title: 'Connect your own agent' },
  { route: 'operate', from: 'docs/operations/README.md' },
  { route: 'operate/requirements', from: 'docs/operations/requirements.md' },
  { route: 'operate/install', from: 'docs/operations/install.md' },
  { route: 'operate/configuration', from: 'docs/operations/configuration.md', tocDepth: 2 },
  { route: 'operate/administration', from: 'docs/operations/administration.md' },
  { route: 'operate/architecture', from: 'docs/operations/architecture.md' },
  { route: 'operate/encrypted-spaces', from: 'docs/operations/encrypted-spaces.md' },
  { route: 'operate/monitoring', from: 'docs/operations/monitoring.md' },
  { route: 'operate/scaling', from: 'docs/operations/scaling.md' },
  { route: 'operate/hardening', from: 'docs/operations/hardening.md' },
  { route: 'operate/troubleshooting', from: 'docs/operations/troubleshooting.md' },
  { route: 'operate/mobile-and-push', from: 'docs/operations/mobile-and-push.md' },
  { route: 'operate/install-release', from: 'docs/operations/install-release.md' },
  { route: 'operate/release-guide', from: 'docs/operations/release-guide.md' },
  { route: 'operate/upgrade', from: 'docs/operations/upgrade.md' },
  { route: 'operate/backup-restore', from: 'docs/operations/backup-restore.md' },
  { route: 'operate/export', from: 'docs/operations/export.md' },
  { route: 'operate/reverse-proxy', from: 'docs/operations/reverse-proxy.md' },
  { route: 'operate/single-sign-on', from: 'docs/operations/single-sign-on.md' },
  { route: 'operate/agent-runtime', from: 'docs/operations/agent-runtime.md' },
  { route: 'integrate', from: 'docs/integrations/README.md' },
  {
    route: 'security/encrypted-spaces', from: 'docs/product/encrypted-workspaces.md', title: 'Encrypted spaces',
    sections: ['Threat model', 'Terms', 'What stays visible metadata', 'Locked behaviour', 'Behaviour while unlocked',
      'AI forced off', 'Creating an encrypted space', 'Not in scope'],
  },
  { route: 'security', from: 'docs/SECURITY.md' },
  { route: 'contribute', from: 'docs/CONTRIBUTING.md' },
  { route: 'contribute/governance', from: 'GOVERNANCE.md' },
  { route: 'contribute/licensing', from: 'docs/product/licensing.md' },
  { route: 'contribute/changelog', from: 'CHANGELOG.md' },
];

const slug = (text) => text.toLowerCase().trim()
  .replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-');

/** Splits Markdown into lines with a flag for lines inside fenced code. */
function lines(markdown) {
  let fence = null;
  return markdown.split('\n').map((text) => {
    const marker = text.match(/^\s*(```+|~~~+)/);
    const inCode = fence !== null || !!marker;
    if (marker) fence = fence === null ? marker[1] : (marker[1].startsWith(fence) ? null : fence);
    return { text, inCode, heading: !inCode && !marker ? text.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/) : null };
  });
}

/** The chosen sections, each starting at its heading and ending before the next heading of its level or higher. */
function pickSections(markdown, names, from) {
  const all = lines(markdown);
  const picked = [];
  for (const name of names) {
    const start = all.findIndex((line) => line.heading && line.heading[2] === name);
    if (start < 0) throw new Error(`${from}: no heading "${name}"`);
    const level = all[start].heading[1].length;
    let end = all.findIndex((line, index) => index > start && line.heading && line.heading[1].length <= level);
    if (end < 0) end = all.length;
    picked.push({ level, body: all.slice(start, end).map((line) => line.text) });
  }
  return picked;
}

/** Moves headings so that the shallowest becomes `top`. */
function shiftHeadings(markdown, top) {
  const all = lines(markdown);
  const levels = all.filter((line) => line.heading).map((line) => line.heading[1].length);
  if (!levels.length) return markdown;
  const by = top - Math.min(...levels);
  return all.map((line) => (line.heading ? `${'#'.repeat(Math.min(6, line.heading[1].length + by))} ${line.heading[2]}` : line.text)).join('\n');
}

const routeOf = new Map(); // "path" or "path#anchor" -> site URL
for (const page of PAGES) {
  const url = `${BASE}/${page.route}${page.route ? '/' : ''}`;
  if (page.sections) {
    for (const name of page.sections) routeOf.set(`${page.from}#${slug(name)}`, page.splash ? `${url}#${slug(name)}` : url);
    if (!routeOf.has(page.from) || page.splash) routeOf.set(page.from, url);
  } else {
    routeOf.set(page.from, url);
  }
}
const pageAnchors = new Map(PAGES.filter((page) => !page.sections).map((page) => [page.from, true]));

function copyMedia(repoPath) {
  const source = join(ROOT, repoPath);
  if (!existsSync(source)) throw new Error(`missing image ${repoPath}`);
  const target = join(MEDIA, repoPath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return `${BASE}/media/${repoPath}`;
}

/** Rewrites one link or image target found in `from`. */
function rewrite(target, from, { image = false } = {}) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return target;
  const [rawPath, anchor] = target.split('#');
  const repoPath = posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(rawPath))).replace(/\/$/, '');
  if (repoPath.startsWith('..')) throw new Error(`${from}: link leaves the repository: ${target}`);
  if (image || /\.(png|jpe?g|gif|webp|svg)$/i.test(repoPath)) return copyMedia(repoPath);
  if (anchor && routeOf.has(`${repoPath}#${anchor}`)) return routeOf.get(`${repoPath}#${anchor}`);
  if (routeOf.has(repoPath) && (!anchor || pageAnchors.has(repoPath))) return routeOf.get(repoPath) + (anchor ? `#${anchor}` : '');
  const absolute = join(ROOT, repoPath);
  const kind = existsSync(absolute) && statSync(absolute).isDirectory() ? 'tree' : 'blob';
  return `${REPO}/${kind}/main/${repoPath}${anchor ? `#${anchor}` : ''}`;
}

/** Rewrites Markdown links, images, reference definitions and HTML src/href outside code. */
function rewriteLinks(markdown, from, anchorsHere) {
  const local = (target) => (target.startsWith('#') && anchorsHere && !anchorsHere.has(target.slice(1))
    ? `${REPO}/blob/main/${from}${target}` : target);
  // Rewrite each run of prose lines at once (link text can wrap), leaving fenced code alone.
  const chunks = [];
  for (const line of lines(markdown)) {
    const last = chunks.at(-1);
    if (last && last.inCode === line.inCode) last.text.push(line.text);
    else chunks.push({ inCode: line.inCode, text: [line.text] });
  }
  return chunks.map(({ inCode, text }) => {
    const prose = text.join('\n');
    if (inCode) return prose;
    // Mask inline code so that a path inside backticks is never rewritten.
    const code = [];
    const masked = prose.replace(/(`+)[^`]*?\1/g, (span) => `\u0000${code.push(span) - 1}\u0000`);
    return masked
      .replace(/(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(<?([^)\s>]+)>?((?:\s+"[^"]*")?)\)/g,
        (_, bang, label, target, title) => `${bang}[${label}](${local(rewrite(target, from, { image: !!bang }))}${title})`)
      .replace(/^(\s*\[[^\]]+\]:\s+)(\S+)/gm, (_, head, target) => head + local(rewrite(target, from)))
      .replace(/\b(src|href|srcset)="([^"]+)"/g, (_, attr, target) => `${attr}="${local(rewrite(target, from, { image: attr !== 'href' }))}"`)
      .replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
  }).join('\n');
}

const yaml = (value) => JSON.stringify(value);

function build(page) {
  const source = readFileSync(join(ROOT, page.from), 'utf8');
  const all = lines(source);
  const h1 = all.find((line) => line.heading && line.heading[1] === '#');
  let body;
  if (page.sections) {
    body = pickSections(source, page.sections, page.from)
      .map(({ body: section }) => (page.sections.length === 1 ? section.slice(1) : section).join('\n').trim())
      .join('\n\n');
    body = shiftHeadings(body, 2);
  } else {
    body = all.filter((line) => line !== h1).map((line) => line.text).join('\n');
    body = shiftHeadings(body, 2);
  }
  // Places reserved for screenshots that are not captured yet stay in the repository only.
  body = body.replace(/<!--\s*MEDIA SLOT[\s\S]*?-->\n?/g, '');
  const anchorsHere = new Set(lines(body).filter((line) => line.heading).map((line) => slug(line.heading[2])));
  for (const match of body.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchorsHere.add(match[1]);
  body = rewriteLinks(body, page.from, anchorsHere).trim();

  const title = page.title ?? (page.splash ? 'Flux' : h1?.heading[2].replace(/`/g, ''));
  if (!title) throw new Error(`${page.from}: no title`);
  const front = [`title: ${yaml(title)}`, `editUrl: ${yaml(`${REPO}/edit/main/${page.from}`)}`];
  // A long reference lists only its sections in the page's table of contents.
  if (page.tocDepth) front.push('tableOfContents:', '  minHeadingLevel: 2', `  maxHeadingLevel: ${page.tocDepth}`);
  if (page.splash) {
    const pitch = source.match(/<p align="center"><b>(.+?)<\/b><\/p>/);
    if (!pitch) throw new Error('README.md: no centred bold pitch under the header');
    front.push('template: splash', 'hero:', `  tagline: ${yaml(pitch[1])}`, '  image:',
      '    light: ../../../../docs/assets/brand/kreska-light.svg', '    dark: ../../../../docs/assets/brand/kreska-dark.svg',
      '  actions:', '    - text: Quick start', `      link: ${BASE}/start/quick-start/`, '      icon: right-arrow',
      '    - text: Connect your agent', `      link: ${BASE}/start/connect-your-agent/`, '      variant: minimal',
      '    - text: Self-host', `      link: ${BASE}/operate/`, '      variant: minimal',
      '    - text: GitHub', `      link: ${REPO}`, '      variant: minimal', '      icon: github');
    // The screenshots under the README header lead the page too.
    const shots = source.match(/<p align="center">\s*<img[\s\S]*?<\/p>\s*\n\s*<p align="center"><sub>[\s\S]*?<\/sub><\/p>/);
    if (shots) body = `${rewriteLinks(shots[0], page.from)}\n\n${body}`;
    // The promo animation at the top of the README (#780) leads the page above them.
    const promo = source.match(/<p align="center">\s*<picture>\s*<source[^>]*flux-promo[\s\S]*?<\/p>\s*\n\s*<p align="center"><sub>[\s\S]*?<\/sub><\/p>/);
    if (promo) body = `${rewriteLinks(promo[0], page.from)}\n\n${body}`;
  }
  const file = join(OUT, `${page.route || 'index'}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${front.join('\n')}\n---\n\n<!-- Generated from ${page.from} by site/scripts/sync-docs.mjs. Edit the source. -->\n\n${body}\n`);
}

rmSync(OUT, { recursive: true, force: true });
rmSync(MEDIA, { recursive: true, force: true });
for (const page of PAGES) build(page);
mkdirSync(join(SITE, 'public/fonts'), { recursive: true });
for (const font of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
  copyFileSync(join(ROOT, 'app/apps/web/src/ui/fonts', font), join(SITE, 'public/fonts', font));
}
// The fonts' licence ships with the web app's built assets (app/apps/web/public/fonts) and with the site.
copyFileSync(join(ROOT, 'app/apps/web/public/fonts/OFL.txt'), join(SITE, 'public/fonts/OFL.txt'));
copyFileSync(join(ROOT, 'docs/assets/brand/kreska-light.svg'), join(SITE, 'public/favicon.svg'));
console.log(`sync-docs: ${PAGES.length} pages from ${new Set(PAGES.map((page) => page.from)).size} files into ${relative(ROOT, OUT)}`);
