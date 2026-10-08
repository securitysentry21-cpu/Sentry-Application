// Lint is a security control here, not style: several spec rules are enforced as lint errors.
// A negative control (scripts/negative-controls.ts, ADV-X02) proves lint actually fails.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ARCH §3: domain logic and services read time from an injected Clock.
const noWallClock = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Read time from the injected Clock (ARCH §3); Date.now() is banned here.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Read time from the injected Clock (ARCH §3); new Date() without arguments is banned here.',
  },
];

// SEC §8: user text always renders as text.
const noRawHtml = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'User-supplied text must render as text (SEC §8, ADV-W01).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/coverage/**',
      '.local/**',
      '.tmp/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      '**/next-env.d.ts',
      'packages/db/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', ...noRawHtml],
      // ARCH §4.2: SQL lives in packages/db and in repositories only.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Database access goes through packages/db or a repository (ARCH §4.2).' },
            {
              name: 'kysely',
              importNames: ['sql'],
              message: 'Raw SQL lives in packages/db or a repository (ARCH §4.2).',
            },
          ],
        },
      ],
    },
  },
  {
    // Where SQL is allowed.
    files: ['packages/db/**', '**/repositories/**', 'apps/api/src/db/**', 'apps/api/test/**', 'scripts/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Where reading the wall clock is banned.
    files: ['packages/domain/src/**', 'apps/api/src/services/**'],
    ignores: ['packages/domain/src/clock.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noWallClock, ...noRawHtml] },
  },
  {
    // Plain JavaScript config files are not type-checked.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
