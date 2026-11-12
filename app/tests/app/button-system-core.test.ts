import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { buttonElements, handDrawnButtonRoles, loadApprovedClasses, NON_ACTION_ROLES, SYSTEM_CLASS, SYSTEM_FILES, unapprovedButtons } from './support/button-system.js';

// One button system everywhere (#1233, docs/design/final/README.md, Buttons). Every action is a Button (ui-btn) or an IconButton
// (ui-icon-btn). A raw <button> is a control of a named kind (a menu row, a whole-row target, a shell or composer control, an
// inline text link, a chip, a dismiss cross or a map tool): its class is listed in tests/app/button-classes.json with that kind.
// A screen that draws its own button class fails here; use Button instead of adding to the list.
const root = resolve(import.meta.dirname, '../..');
const web = join(root, 'apps/web/src');
const classesFile = join(root, 'tests/app/button-classes.json');

function webSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? webSources(path) : /\.tsx$/.test(path) ? [path] : [];
  });
}

describe('the button system', () => {
  const { approved, categories } = loadApprovedClasses(classesFile);
  const sources = webSources(web).map((path) => ({ path, name: relative(web, path), text: readFileSync(path, 'utf8') }));

  test('every raw <button> in the web app is a system button or a control of an approved kind', () => {
    assert.ok(sources.length >= 100, `the scan covers the web sources (found ${sources.length})`);
    assert.ok(sources.some((source) => source.name === 'ui/Button.tsx'), 'the shared Button exists');
    const found = sources.filter((source) => !SYSTEM_FILES.includes(source.name))
      .flatMap((source) => unapprovedButtons(source.text, approved).map(({ line, classes }) => `${source.name}:${line}${classes.length ? ` (${classes.join(' ')})` : ''}`));
    assert.deepEqual(found, [], 'use Button from ../ui (variant primary, secondary, outline, quiet, link, danger; IconButton for an icon). '
      + 'A control that is not an action button (a menu row, a row target, a chip, a canvas tool) uses a class of tests/app/button-classes.json');
  });

  test('no element is given role="button" by hand', () => {
    const found = sources.flatMap((source) => handDrawnButtonRoles(source.text).map((line) => `${source.name}:${line}`));
    assert.deepEqual(found, [], 'use a <Button> or an approved control, not role="button"');
  });

  test('every approved class is still used by a raw <button>, so the list only shrinks', () => {
    const used = new Set(sources.flatMap((source) => buttonElements(source.text).flatMap((button) => button.classes)));
    const stale = [...approved].filter((name) => !used.has(name));
    assert.deepEqual(stale, [], 'remove these classes from tests/app/button-classes.json: no <button> uses them any more');
  });

  test('every kind of control is described and the system classes are not on the list', () => {
    assert.ok(Object.keys(categories).length >= 5);
    for (const [kind, { description, classes }] of Object.entries(categories)) {
      assert.ok(description.length > 30, `${kind} says what it is`);
      assert.ok(classes.length > 0, `${kind} has classes`);
      assert.deepEqual(classes.filter((name) => SYSTEM_CLASS.test(name)), [], `${kind} lists a system class`);
    }
  });

  test('the guard finds raw buttons, their classes and their roles, and ignores comments and strings (self-test)', () => {
    const none = new Set<string>();
    assert.deepEqual(unapprovedButtons('const a = <button type="button" onClick={() => go()}>Go</button>;', none), [{ line: 1, classes: [] }]);
    assert.deepEqual(unapprovedButtons('<div>\n  <button\n    type="button"\n    className="go-button"\n  >Go</button></div>', none), [{ line: 2, classes: ['go-button'] }]);
    assert.deepEqual(unapprovedButtons('<button className="ui-btn ui-btn--primary">Go</button>', none), []);
    assert.deepEqual(unapprovedButtons('<button className={`ui-btn ui-btn--${variant}`}>Go</button>', none), []);
    assert.deepEqual(unapprovedButtons("<button className={['ui-icon-btn', className].filter(Boolean).join(' ')}>x</button>", none), []);
    assert.deepEqual(unapprovedButtons('<button className="go-button">Go</button>', new Set(['go-button'])), []);
    assert.deepEqual(unapprovedButtons("<button className={`origin-back${className ? ` ${className}` : ''}`}>Back</button>", new Set(['origin-back'])), []);
    assert.deepEqual(unapprovedButtons("<button className={`tile${on ? ' is-on' : ''}`}>x</button>", new Set(['tile'])), []);
    assert.deepEqual(unapprovedButtons('<button className={cls}>Go</button>', none), [{ line: 1, classes: [] }]);
    for (const role of NON_ACTION_ROLES) assert.deepEqual(unapprovedButtons(`<button role="${role}">x</button>`, none), []);
    assert.deepEqual(unapprovedButtons('<button role="link">x</button>', none), [{ line: 1, classes: [] }]);
    assert.deepEqual(unapprovedButtons('// <button>not code</button>\n/* <button>nor this</button> */\nconst a = "x";\n<Button>Go</Button>;', none), []);
    assert.deepEqual(unapprovedButtons('<ButtonGroup><buttons /></ButtonGroup>', none), []);
    assert.deepEqual(unapprovedButtons('<div>\n<button onClick={(event) => { if (a > b) go(); }} data-x="a>b">Go</button>', none), [{ line: 2, classes: [] }]);
    assert.deepEqual(handDrawnButtonRoles('<div role="button" tabIndex={0}>x</div>\nconst q = \'[role="button"]\';'), [1]);
  });
});
