// dsh-jenkins ESLint flat config（HOST-M1-01）
// 仅启用 typescript-eslint recommended（非类型检查模式），覆盖 src/tests 及工程配置文件；
// lib/、dist/、.pnpm-cache/ 等产物目录忽略。
import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // 骨架阶段未使用的参数/变量以下划线前缀标注（如 apply(_ctx, _config)）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['lib/**', 'dist/**', 'coverage/**', '.pnpm-cache/**', '.pnpm-store/**', 'node_modules/**'],
  },
)
