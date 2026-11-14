import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';

// A Settings page must not change with how it was reached (final design, principle 7; v0.2.1 UI audit P2-1). settings.css and a screen's
// own stylesheet (my-agents.css, connect-ai.css, …) are separate chunks: a full load of /settings/agents inserts them in another order than
// in-app navigation does, so where an element carries a Settings class (`sset-row__ic`) and a screen class (`agl__face`) and two rules of
// the same specificity set the same property, the later stylesheet wins and the page differs between a reload and a click. The screen's rule
// is compound with the Settings class instead (`.sset-row__ic.agl__face`), so it wins in either order. This test finds every such pair in
// the web sources; tests/ui/test_settings_load_order.py measures the rendered pages both ways.
const root = resolve(import.meta.dirname, '../..');
const web = join(root, 'apps/web/src');
const SETTINGS = 'app/settings.css';
const SETTINGS_CLASS = /^(?:sset|set)-|^proj-index/;

type Rule = { file: string; selector: string; context: string; declarations: Map<string, string> };

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, pattern) : pattern.test(path) ? [path] : [];
  });
}

/** Splits at top-level commas or combinators, never inside `:is(…)` and the like. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && separator.test(char)) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseRules(file: string, css: string, context = ''): Rule[] {
  const rules: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    let depth = 1, close = open + 1;
    for (; close < text.length && depth; close += 1) {
      if (text[close] === '{') depth += 1;
      else if (text[close] === '}') depth -= 1;
    }
    const head = text.slice(index, open).split(';').pop()!.trim();
    const body = text.slice(open + 1, close - 1);
    if (head.startsWith('@')) {
      // Rules inside a media, container or supports query still match while it holds; keyframes and font faces style no element.
      if (/^@(?:media|container|supports|layer)\b/.test(head)) rules.push(...parseRules(file, body, `${context}${head} `));
    } else {
      const declarations = new Map<string, string>();
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
      }
      for (const selector of splitTopLevel(head, /,/)) rules.push({ file, selector, context: context.trim(), declarations });
    }
    index = close;
  }
  return rules;
}

/** The classes of the element the selector styles (its last compound), outside `:not(…)`, `:is(…)` and other parentheses. */
function subjectClasses(selector: string): string[] {
  const compound = splitTopLevel(selector.replace(/\s*([>+~])\s*/g, ' '), /\s/).pop() ?? '';
  return [...compound.replace(/\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((match) => match[1]!);
}

function specificity(selector: string): number {
  let ids = 0, classes = 0, types = 0;
  const flat = selector.replace(/:where\([^)]*\)/g, '').replace(/:(?:is|not|has)\(([^,)]*)[^)]*\)/g, ' $1');
  ids += (flat.match(/#[\w-]+/g) ?? []).length;
  classes += (flat.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
  types += (flat.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length + (flat.match(/::[\w-]+/g) ?? []).length;
  return ids * 10_000 + classes * 100 + types;
}

const LONGHANDS: Record<string, string[]> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], 'margin-block': ['margin-top', 'margin-bottom'],
  'margin-inline': ['margin-left', 'margin-right'], padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'padding-block': ['padding-top', 'padding-bottom'], 'padding-inline': ['padding-left', 'padding-right'], gap: ['row-gap', 'column-gap'],
  border: ['border-top', 'border-right', 'border-bottom', 'border-left'], 'border-width': ['border-top', 'border-right', 'border-bottom', 'border-left'],
  inset: ['top', 'right', 'bottom', 'left'], flex: ['flex-grow', 'flex-shrink', 'flex-basis'], 'flex-flow': ['flex-direction', 'flex-wrap'],
  font: ['font-size', 'font-weight', 'font-family', 'line-height', 'font-style'], background: ['background-color', 'background-image', 'background-clip'],
  'place-items': ['align-items', 'justify-items'], overflow: ['overflow-x', 'overflow-y'], 'list-style': ['list-style-type', 'list-style-position'],
};
const longhands = (property: string) => LONGHANDS[property] ?? [property];

/** The properties the two rules both set to different values (a shorthand against a longhand always counts). */
function clashing(a: Rule, b: Rule): string[] {
  const clashes = new Set<string>();
  for (const [pa, va] of a.declarations) {
    for (const [pb, vb] of b.declarations) {
      if (pa === pb && va === vb) continue;
      for (const property of longhands(pa)) if (longhands(pb).includes(property)) clashes.add(property);
    }
  }
  return [...clashes];
}

/** The class sets one element is given: every `className` of the TSX sources, with the classes its string literals can produce. */
function classNames(source: string): { line: number; classes: Set<string> }[] {
  const found: { line: number; classes: Set<string> }[] = [];
  for (const match of source.matchAll(/className=(\{|")/g)) {
    const start = match.index! + match[0].length;
    let expression: string;
    if (match[1] === '"') expression = `"${source.slice(start, source.indexOf('"', start))}"`;
    else {
      let depth = 1, end = start;
      for (; end < source.length && depth; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
      }
      expression = source.slice(start, end - 1);
    }
    // A template's own text, and every quoted string, the ones inside its `${…}` too.
    const literals = [
      ...[...expression.matchAll(/`([^`]*)`/g)].map((template) => template[1]!.replace(/\$\{[^}]*\}/g, ' ')),
      ...[...expression.replace(/`/g, ' ').matchAll(/'([^']*)'|"([^"]*)"/g)].map((quoted) => quoted[1] ?? quoted[2] ?? ''),
    ];
    const classes = new Set(literals.join(' ').split(/\s+/).filter((name) => /^[a-z][\w-]*$/.test(name)));
    if (classes.size > 1) found.push({ line: source.slice(0, match.index).split('\n').length, classes });
  }
  return found;
}

/** Every Settings rule and screen rule of equal specificity that set one property of one element differently, unless a stronger rule decides it. */
function orderDependentRules(): string[] {
  const rules = files(web, /\.css$/).flatMap((path) => parseRules(relative(web, path), readFileSync(path, 'utf8')));
  const settings = rules.filter((rule) => rule.file === SETTINGS);
  const settingsClasses = new Set(settings.flatMap((rule) => subjectClasses(rule.selector)).filter((name) => SETTINGS_CLASS.test(name)));
  const subjects = new Map(rules.map((rule) => [rule, subjectClasses(rule.selector)]));
  const problems = new Set<string>();
  for (const path of files(web, /\.tsx$/)) {
    for (const { line, classes } of classNames(readFileSync(path, 'utf8'))) {
      if (![...classes].some((name) => settingsClasses.has(name))) continue;
      const applies = (rule: Rule) => { const own = subjects.get(rule)!; return own.length > 0 && own.every((name) => classes.has(name)); };
      const base = settings.filter((rule) => applies(rule) && subjects.get(rule)!.some((name) => settingsClasses.has(name)));
      const screen = rules.filter((rule) => rule.file !== SETTINGS && applies(rule) && subjects.get(rule)!.some((name) => !settingsClasses.has(name)));
      for (const a of base) {
        for (const b of screen) {
          const weight = specificity(a.selector);
          if (weight !== specificity(b.selector)) continue;
          // Only a rule about this element alone decides it: one under another element (`.cai__row .sset-row__t`) may not hold here.
          const decided = rules.filter((rule) => applies(rule) && !/[\s>+~]/.test(rule.selector.replace(/\([^)]*\)/g, '')) && specificity(rule.selector) > weight).flatMap((rule) => [...rule.declarations.keys()].flatMap(longhands));
          const open = clashing(a, b).filter((property) => !decided.includes(property));
          if (open.length) {
            problems.add(`${relative(web, path)}:${line}: ${b.file} \`${b.selector}\`${b.context ? ` (${b.context})` : ''} against ${SETTINGS} \`${a.selector}\``
              + `${a.context ? ` (${a.context})` : ''}: ${open.sort().join(', ')}`);
          }
        }
      }
    }
  }
  return [...problems].sort();
}

describe('Settings styles do not depend on the order the stylesheets load in', () => {
  test('the scan reads the Settings rules and the screens that use them', () => {
    const css = readFileSync(join(web, SETTINGS), 'utf8');
    const parsed = parseRules(SETTINGS, css);
    assert.ok(parsed.some((rule) => rule.selector === '.sset-row__ic' && rule.declarations.get('width') === '24px'), 'settings.css is parsed');
    assert.deepEqual(subjectClasses('.sset-card > .sset-row + .sset-row'), ['sset-row']);
    assert.deepEqual(subjectClasses('.sset-row--field > :is(.ui-select, .ui-btn)'), []);
    assert.equal(specificity('.sset-row__ic.agl__face'), specificity('.sset-sub') * 2);
    // The pair the v0.2.1 audit found is reported when it is written the old way.
    const before = parseRules('my-agents/my-agents.css', '.agl__face { width: 36px; }')[0]!;
    const base = parsed.find((rule) => rule.selector === '.sset-row__ic')!;
    assert.deepEqual(clashing(base, before), ['width']);
    assert.equal(specificity(base.selector), specificity(before.selector));
    const used = classNames('<span className="sset-row__ic agl__face" /><b className={`sset-row ${on ? \'is-on\' : \'\'}`} />');
    assert.deepEqual(used.map((item) => [...item.classes]), [['sset-row__ic', 'agl__face'], ['sset-row', 'is-on']]);
  });

  test('a screen rule for an element with a Settings class is compound with it where both set one property', () => {
    assert.deepEqual(orderDependentRules(), [], 'write the screen rule as `.sset-x.screen__y` so it wins over settings.css whatever order the stylesheets load in');
  });
});
