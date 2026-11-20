import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const BARE_AUTOFOCUS = 'A text field says whether it takes the focus on a touch screen: autoFocus={writeNow} (the person asked to write now) or autoFocus={focusesOnOpen()} (it opened with its screen), ui/focusField.ts (#1546).';

export default tseslint.config(
  { ignores: [
    '**/dist/**', '**/node_modules/**',
    // Immutable copies of independently run probes are historical evidence;
    // maintained application regressions remain under tests/app and are linted.
    'docs/development/evidence/**',
    // A vendored, minified test tool (axe-core, tests/ui/vendor/README.md); never application code.
    'tests/ui/vendor/**',
  ] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['apps/web/**/*.{ts,tsx}'], ...reactHooks.configs.flat.recommended },
  {
    // No keyboard without a tap on a touch screen (#1546): a text field never takes a bare `autoFocus`; it says whether it is an action to
    // write now (`autoFocus={writeNow}`) or a field that opened with its screen (`autoFocus={focusesOnOpen()}`), ui/focusField.ts.
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'JSXOpeningElement[name.name=/^(input|textarea|Input)$/] > JSXAttribute[name.name="autoFocus"][value=null]', message: BARE_AUTOFOCUS },
        { selector: 'JSXOpeningElement[name.name=/^(input|textarea|Input)$/] > JSXAttribute[name.name="autoFocus"] > JSXExpressionContainer > Literal[value=true]', message: BARE_AUTOFOCUS },
      ],
    },
  },
);
