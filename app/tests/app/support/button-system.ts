import { readFileSync } from 'node:fs';

/**
 * The button system's guard (#1233). Every action in the product is a `Button` of the shared system (`ui-btn`), an
 * `IconButton` (`ui-icon-btn`), or a control of a named kind that is not an action button: a menu row, a whole-row target,
 * a shell or composer control, an inline text link, a chip, a dismiss cross or a map tool. A raw `<button>` carries one of
 * those classes, listed in tests/app/button-classes.json with its kind, or has a role that is not an action (menuitem,
 * tab, radio, switch...). A new screen that draws its own button class fails here, so buttons cannot drift again.
 */

/** Roles of a raw `<button>` that are controls of their own kind, styled by their container (menus, tab lists, radio groups). */
export const NON_ACTION_ROLES = new Set(['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'tab', 'radio', 'switch', 'combobox', 'checkbox']);

/** The classes that make a button a button of the system: `ui-btn` and the icon button themselves. A variant or a size alone (`ui-btn--fancy`) is not one. */
export const SYSTEM_CLASS = /^ui-(btn|icon-btn)$/;

/** Every class of the system's family, variants and sizes included: none of them may be listed as an approved class of a raw button. */
export const SYSTEM_FAMILY = /^ui-(btn|icon-btn)(--[a-z]+)?$/;

/** Files that define the system itself: they may draw a `<button>` from their own props. */
export const SYSTEM_FILES = ['ui/Button.tsx'];

export interface ButtonElement {
  line: number;
  classes: string[];
  role: string | null;
}

/**
 * Comments blanked out, keeping every newline so line numbers stay right. A `//` or a `/*` inside a quoted string is text, not a comment:
 * a quote opens a string for the rest of its line (a backtick, until the next backtick), so an apostrophe in JSX text only ever keeps
 * more of the line, never hides code. A `//` is a comment only where code can end: at the start of a line or after `; , { } ( ) [ ] =`.
 * After anything else it is text (JSX text such as `<span>a // b</span>`, a URL), so it hides nothing; a trailing comment after an
 * identifier is then kept, which can only report a button that is not there, never miss one.
 */
function withoutComments(source: string): string {
  let result = '';
  let quote = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote) {
      result += char;
      if (char === '\\') result += source[++index] ?? '';
      else if (char === quote || (char === '\n' && quote !== '`')) quote = '';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      result += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop - 1;
    } else if (char === '/' && next === '/' && /(^|[;,{}()[\]=\n])[ \t]*$/.test(result.slice(-200))) {
      while (index < source.length && source[index] !== '\n') { result += ' '; index++; }
      index--;
    } else {
      if (char === '"' || char === "'" || char === '`') quote = char;
      result += char;
    }
  }
  return result;
}

/** The end of an opening tag that starts at `start`: the `>` that is outside every `{}` expression and quoted string. */
function tagEnd(code: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let index = start; index < code.length; index++) {
    const char = code[index]!;
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === '>' && depth === 0) return index;
  }
  return code.length;
}

/** A template literal's `${...}` placeholders blanked out, braces balanced, so a template inside a placeholder cannot end the outer one. */
function withoutPlaceholders(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '$' && text[index + 1] === '{') {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      result += ' ';
      index = end;
    } else result += text[index];
  }
  return result;
}

/** The class names a `className` attribute can produce: the words of every string in it, template placeholders dropped. */
function classNames(attributes: string): string[] {
  const start = attributes.search(/\bclassName\s*=/);
  if (start < 0) return [];
  let index = attributes.indexOf('=', start) + 1;
  while (/\s/.test(attributes[index] ?? '')) index++;
  let expression: string;
  if (attributes[index] === '{') {
    let depth = 0;
    let end = index;
    for (; end < attributes.length; end++) {
      if (attributes[end] === '{') depth++;
      else if (attributes[end] === '}' && --depth === 0) break;
    }
    expression = attributes.slice(index + 1, end);
  } else {
    expression = attributes.slice(index).match(/^(["'])(.*?)\1/s)?.[2] ?? '';
    return expression.split(/\s+/).filter(Boolean);
  }
  const words: string[] = [];
  for (const [, , text] of withoutPlaceholders(expression).matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs)) {
    for (const word of text!.split(/\s+/)) if (word) words.push(word);
  }
  return words;
}

/** The words of an attribute's value when it is a plain string: `role="x"`, `role='x'`, `role={"x"}`, `role={'x'}` or `role={`x`}`. */
const ROLE = /\brole\s*=\s*(?:\{\s*)?(["'`])([a-z]+)\1/;

/** Every raw `<button>` of a source file: its line, its class names and its role. */
export function buttonElements(source: string): ButtonElement[] {
  const code = withoutComments(source);
  const found: ButtonElement[] = [];
  for (const match of code.matchAll(/<button(?=[\s/>])/g)) {
    const start = match.index! + '<button'.length;
    const attributes = code.slice(start, tagEnd(code, start));
    found.push({
      line: code.slice(0, match.index).split('\n').length,
      classes: classNames(attributes),
      role: attributes.match(ROLE)?.[2] ?? null,
    });
  }
  return found;
}

/** The lines of raw `<button>` elements that are neither a system button, nor of a role that is not an action, nor an approved class. */
export function unapprovedButtons(source: string, approved: ReadonlySet<string>): { line: number; classes: string[] }[] {
  return buttonElements(source)
    .filter((button) => !(button.role && NON_ACTION_ROLES.has(button.role)))
    .filter((button) => !button.classes.some((name) => SYSTEM_CLASS.test(name) || approved.has(name)))
    .map(({ line, classes }) => ({ line, classes }));
}

/**
 * `role="button"` on an element that is not a `<button>`: a button drawn by hand, which the system has no room for. Any quoting is found,
 * and so is an expression that can give it: `role={cond ? 'button' : undefined}`.
 */
export function handDrawnButtonRoles(source: string): number[] {
  const code = withoutComments(source);
  return [...code.matchAll(/\srole\s*=\s*(?:["'`]button["'`]|\{[^{}]*["'`]button["'`][^{}]*\})/g)].map((match) => code.slice(0, match.index).split('\n').length);
}

/**
 * The CSS rules that draw a system button (`.ui-btn` and its variants) with a shape of their own: a pill or a circle. The system's
 * radius is 10 (`--r-btn`), set once in ui/ui.css; the icon button is its own round shape and is not checked.
 */
export function pillButtonRules(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]*\.ui-btn(?:--[a-z]+)?(?![\w-])[^{}]*)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /border-radius\s*:\s*(var\(--r-pill\)|\d{3,}px|50%)/.test(body!))
    .map(([, selector]) => selector!.trim().replace(/\s+/g, ' '));
}

export interface ButtonClasses {
  categories: Record<string, { description: string; classes: string[] }>;
}

export function loadApprovedClasses(path: string): { approved: Set<string>; categories: ButtonClasses['categories'] } {
  const { categories } = JSON.parse(readFileSync(path, 'utf8')) as ButtonClasses;
  return { approved: new Set(Object.values(categories).flatMap((category) => category.classes)), categories };
}
