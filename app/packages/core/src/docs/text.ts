import { DOC_LIMITS, docRef, type DocSectionSource, type DocState } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

// Pure input rules and text composition for project docs (#112).

export function title(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > DOC_LIMITS.title) throw new InvalidInputError(`title must be 1–${DOC_LIMITS.title} characters`);
  return trimmed;
}

/** Markdown source. Line endings are normalized so versions and diffs compare lines. */
export function body(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > DOC_LIMITS.body) throw new InvalidInputError(`body must be at most ${DOC_LIMITS.body} characters`);
  return value.replace(/\r\n?/g, '\n');
}

export function state(value: unknown): DocState {
  if (value !== 'draft' && value !== 'published') throw new InvalidInputError('state must be draft or published');
  return value;
}

export function reason(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InvalidInputError('reason must be text');
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > DOC_LIMITS.reason) throw new InvalidInputError(`reason must be at most ${DOC_LIMITS.reason} characters`);
  return trimmed;
}

export function sectionSource(value: unknown): DocSectionSource {
  const raw = value as { type?: unknown; id?: unknown } | null | undefined;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!raw || typeof raw !== 'object' || (raw.type !== 'result' && raw.type !== 'decision') || typeof raw.id !== 'string' || !UUID.test(raw.id))
    throw new InvalidInputError('from must be { type: "result" | "decision", id }');
  return { type: raw.type, id: raw.id.toLowerCase() };
}

const quote = (text: string) => `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;

/** What changed between two versions, in words, when the author gave no reason. */
export function describeChange(previous: { title: string; body: string; state: DocState }, next: { title: string; body: string; state: DocState }): string {
  const parts: string[] = [];
  if (previous.state !== next.state) parts.push(next.state === 'published' ? 'Published' : 'Moved back to draft');
  if (previous.title !== next.title) parts.push(`Renamed to ${quote(next.title)}`);
  if (previous.body !== next.body) parts.push('Edited the text');
  return parts.join(' · ');
}

/** Escapes text so it reads literally inside a Markdown line or link label. */
export function literal(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/([\\`*_{}[\]()#+!<>|~])/g, '\\$1');
}

const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const dateLine = (date: Date) => day.format(date);

/** The line that marks a section as the one for `source`; kept when the section is rewritten. */
export function sourceLine(source: DocSectionSource, label: string) {
  return `Source: [${literal(label)}](${docRef(source.type, source.id)})`;
}

const HEADING = /^(#{1,6})[ \t]+\S/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Heading lines outside fenced code, with their level. */
function headings(lines: string[]) {
  const found: { index: number; level: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const opener = FENCE.exec(line)?.[1];
    if (opener) {
      if (!fence) fence = opener[0]!;
      else if (opener[0] === fence) fence = null;
      return;
    }
    const heading = fence ? null : HEADING.exec(line);
    if (heading) found.push({ index, level: heading[1]!.length });
  });
  return found;
}

/**
 * Adds the section of a result or decision to a doc text, or rewrites the section that already
 * cites it (its `Source:` line names the same reference). Earlier text stays in the earlier
 * version; the rest of the doc is untouched. Returns the new text and whether a section existed.
 */
export function upsertSection(text: string, source: DocSectionSource, section: string): { body: string; replaced: boolean } {
  const lines = text.split('\n');
  const marker = `](${docRef(source.type, source.id)})`;
  const markerAt = lines.findIndex((line) => line.startsWith('Source: [') && line.trimEnd().endsWith(marker));
  const all = headings(lines);
  const start = markerAt < 0 ? undefined : [...all].reverse().find((heading) => heading.index < markerAt);
  const sectionLines = section.replace(/\n+$/, '').split('\n');
  if (!start) {
    const kept = text.replace(/\s+$/, '');
    return { body: kept ? `${kept}\n\n${sectionLines.join('\n')}\n` : `${sectionLines.join('\n')}\n`, replaced: false };
  }
  const end = all.find((heading) => heading.index > start.index && heading.level <= start.level)?.index ?? lines.length;
  const before = lines.slice(0, start.index);
  const after = lines.slice(end);
  // Only the section's own lines change; everything around it is kept byte for byte.
  const joined = [...before, ...sectionLines, ...(after.length ? ['', ...after] : [''])].join('\n');
  return { body: joined, replaced: true };
}
