import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/server/drizzle/**', 'design/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 前端详情页、测试、REST 路由里处理的是动态 JSON，允许 any
    files: ['apps/web/**', '**/*.test.ts', 'apps/server/src/api/**', 'apps/server/src/domain/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
