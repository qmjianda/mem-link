import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 只拦真实缺陷，不做风格改造：
 * - 类型相关的判断交给 `tsc --noEmit`，这里不重复；
 * - 与既有代码风格冲突的规则（显式 any、空块、case 声明）不启用，
 *   否则第一天上百条告警会让人直接关掉 lint。
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.cache/**', 'samples/**', 'scripts/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'types/**/*.d.ts'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // --- 真实缺陷 ---
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-unsafe-finally': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // --- 交给 tsc / 既有风格，避免噪声 ---
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // pack 的编译产物本来就是动态函数，`Function` 是这条边界的准确类型
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-case-declarations': 'off',
      'no-prototype-builtins': 'off',
    },
  },
);
