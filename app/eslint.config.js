import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

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
);
