import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Use the typescript-eslint helper to compose configs with typed parserOptions.
// tseslint.config() is kept here because defineConfig() does not automatically
// wire up the TS parser; we suppress the deprecation warning on the next line.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Disallow floating promises – mandatory for Fastify async handlers
      '@typescript-eslint/no-floating-promises': 'error',
      // Unused vars must be prefixed with _ to suppress
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Enforce explicit return types on module-level functions
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // Ban console.log in production code – use the logger
      'no-console': 'error',
      // process.env keys are always string-indexed; bracket notation is correct here
      '@typescript-eslint/dot-notation': 'off',
    },
  },
  {
    // Relax some rules in test files and CLI scripts
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', 'src/scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
);
