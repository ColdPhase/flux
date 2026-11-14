import { DOC_LIMITS, docRef, type DocChangeCause, type DocSectionSource } from '@flux/contracts';
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

/**
 * A sentence a server-side caller wrote for a version: the assistant's "Asked by Ada: …", an Undo, an agent's own words.
 * The HTTP routes never take one; a person sends a {@link cause} and the server writes the sentence.
 */
export function sentence(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InvalidInputError('reason must be text');
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > DOC_LIMITS.reason) throw new InvalidInputError(`reason must be at most ${DOC_LIMITS.reason} characters`);
  return trimmed;
}

/** The causes a save may name; a cause that does not belong to the call is refused. */
export type CauseKind = DocChangeCause['kind'];

/** A person's cause: exactly the shape the contract states, of a kind this call allows. */
export function cause(value: unknown, allowed: readonly CauseKind[]): DocChangeCause | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value as { kind?: unknown; version?: unknown; fileName?: unknown } | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !allowed.includes(raw.kind as CauseKind)) throw new InvalidInputError(`cause.kind must be ${allowed.join(' or ')}`);
  const keys = Object.keys(raw);
  if (raw.kind === 'import') {
    if (keys.some((key) => key !== 'kind' && key !== 'fileName') || typeof raw.fileName !== 'string') throw new InvalidInputError('cause must be { kind: "import", fileName }');
    const fileName = raw.fileName.trim().replace(/\s+/g, ' ');
    if (!fileName || fileName.length > DOC_LIMITS.fileName) throw new InvalidInputError(`cause.fileName must be 1–${DOC_LIMITS.fileName} characters`);
    return { kind: 'import', fileName };
  }
  if (keys.some((key) => key !== 'kind' && key !== 'version') || !Number.isSafeInteger(raw.version) || (raw.version as number) < 1)
    throw new InvalidInputError(`cause must be { kind: "${String(raw.kind)}", version }`);
  return { kind: raw.kind as 'restore' | 'keep_mine' | 'page_left', version: raw.version as number };
}

/**
 * What a file's name looks like in a reason (#1021): the last part of a path, without control or direction characters (a name can
 * carry U+202E, which turns the end of a line around), on one line, and at most {@link FILE_NAME_SHOWN} characters; a long one keeps
 * the start and its extension ("Quarterly review of the lamp sensor ….md").
 */
export const FILE_NAME_SHOWN = 60;
export function fileLabel(name: string): string {
  const clean = name.replace(/\p{Cf}/gu, '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const last = clean.split(/[\\/]/).filter((part) => part.trim()).at(-1)?.trim() || clean || 'a file';
  const shown = Array.from(last);
  if (shown.length <= FILE_NAME_SHOWN) return last;
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(last)?.[0] ?? '';
  return `${shown.slice(0, FILE_NAME_SHOWN - 1 - extension.length).join('').trimEnd()}…${extension}`;
}

/**
 * The sentence for a cause. `theirs` is who wrote the version a `keep_mine` save kept the text over, when that was someone
 * else: a person's own earlier version is no "in place of" and the change is described instead (empty here). The version of
 * `keep_mine` and `page_left` is the one the save really replaced, which the caller reads from the page, never the one the
 * request named (#1021).
 */
export function causeSentence(given: DocChangeCause, theirs: string | null): string {
  switch (given.kind) {
    case 'import': return `Imported from ${fileLabel(given.fileName)}`;
    case 'restore': return `Restored version ${given.version}`;
    case 'keep_mine': return theirs ? `In place of ${theirs}’s version ${given.version}` : '';
    case 'page_left': return `Saved as the page was left, in place of version ${given.version}`;
  }
}

export function sectionSource(value: unknown): DocSectionSource {
  const raw = value as { type?: unknown; id?: unknown } | null | undefined;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!raw || typeof raw !== 'object' || raw.type !== 'decision' || typeof raw.id !== 'string' || !UUID.test(raw.id))
    throw new InvalidInputError('from must be { type: "decision", id }');
  return { type: raw.type, id: raw.id.toLowerCase() };
}

const quote = (text: string) => `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;

/** What changed between two versions, in words, when no cause or sentence says why. */
export function describeChange(previous: { title: string; body: string }, next: { title: string; body: string }): string {
  const parts: string[] = [];
  if (previous.title !== next.title) parts.push(`Renamed to ${quote(next.title)}`);
  if (previous.body !== next.body) parts.push('Edited the text');
  return parts.join(' · ');
}

/** Escapes text so it reads literally inside a Markdown line or link label. */
export function literal(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/([\\`*_{}[\]()#+!<>|~])/g, '\\$1');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

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
  const kept = text.trimEnd();
  return { body: kept ? `${kept}\n\n${line}\n` : `${line}\n`, replaced: false };
}
