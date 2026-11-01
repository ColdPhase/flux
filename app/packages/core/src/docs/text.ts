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

/**
 * Heading lines outside fenced code, with their level. As in CommonMark, a fence closes only on a fence of the
 * same character that is at least as long as the one that opened it, so a four-backtick block can hold a
 * three-backtick block.
 */
function headings(lines: string[]) {
  const found: { index: number; level: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const run = FENCE.exec(line)?.[1];
    if (run) {
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null;
      return;
    }
    const heading = fence ? null : HEADING.exec(line);
    if (heading) found.push({ index, level: heading[1]!.length });
  });
  return found;
}

const CARD_LINE = /^\[(?:\\.|[^\]\\])*\]\(flux:decision\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\s*$/i;

/**
 * F-034: a decision card (a decision reference standing on its own line, outside fenced code) after a section's
 * `Source:` line is never part of that section, so rewriting the section keeps the cards that follow it.
 */
function cardAfter(lines: string[], from: number, end: number) {
  let fence: string | null = null;
  for (let at = from + 1; at < end; at++) {
    const run = FENCE.exec(lines[at]!)?.[1];
    if (run) {
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null;
    } else if (!fence && CARD_LINE.test(lines[at]!)) return at;
  }
  return end;
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
  const next = all.find((heading) => heading.index > start.index && heading.level <= start.level)?.index ?? lines.length;
  const end = cardAfter(lines, markerAt, next);
  const before = lines.slice(0, start.index);
  const after = lines.slice(end);
  // Only the section's own lines change; everything around it is kept byte for byte.
  const joined = [...before, ...sectionLines, ...(after.length ? ['', ...after] : [''])].join('\n');
  return { body: joined, replaced: true };
}

/** Escapes headings inside quoted text so a section keeps its shape. */
export const quotedBlock = (markdown: string) => markdown.trim().split('\n').map((line) => (/^\s{0,3}#{1,6}\s/.test(line) ? `\\${line.trimStart()}` : line)).join('\n');

/**
 * F-034: the one line a decision is in a page, a reference standing alone, which the reader shows as the live
 * decision card. Never a copy of its text.
 */
export function decisionReferenceLine(title: string, id: string) {
  return `[${literal(title) || 'Decision'}](${docRef('decision', id)})`;
}

/** Whether the text already holds a decision's reference on a line of its own (outside fenced code). */
export function hasDecisionReference(text: string, id: string) {
  const marker = `](${docRef('decision', id)})`;
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const run = FENCE.exec(line)?.[1];
    if (run) {
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null;
      continue;
    }
    const trimmed = line.trim();
    if (!fence && trimmed.endsWith(marker) && /^\[(?:\\.|[^\]\\])*\]$/.test(trimmed.slice(0, -marker.length + 1))) return true;
  }
  return false;
}

/**
 * "Add to docs" for a decision (F-034): nothing when its reference line is already there; otherwise the line goes at
 * the end, after a blank line, so it stands alone and the reader shows it as the card.
 */
export function placeDecisionReference(text: string, id: string, title: string, under?: string): { body: string; replaced: boolean } {
  if (hasDecisionReference(text, id)) return { body: text, replaced: false };
  const line = decisionReferenceLine(title, id);
  // CW-9: at the end of the chosen heading's section, before the next heading of its level or above.
  const heading = under?.trim();
  if (heading) {
    const lines = text.split('\n');
    const at = lines.findIndex((value) => value.trim() === heading && /^#{1,6}\s/.test(value.trim()));
    if (at >= 0) {
      const level = /^(#+)/.exec(heading)![1]!.length;
      let end = lines.findIndex((value, index) => index > at && /^(#{1,6})\s/.test(value) && /^(#+)/.exec(value)![1]!.length <= level);
      if (end < 0) end = lines.length;
      let last = end;
      while (last > at + 1 && !lines[last - 1]!.trim()) last--;
      const after = lines.slice(end);
      return { body: [...lines.slice(0, last), '', line, ...(after.length ? ['', ...after] : [''])].join('\n'), replaced: false };
    }
  }
  const kept = text.replace(/\s+$/, '');
  return { body: kept ? `${kept}\n\n${line}\n` : `${line}\n`, replaced: false };
}
