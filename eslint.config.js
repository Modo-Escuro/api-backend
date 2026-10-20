import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '.npm-cache', '.venv-contract', '.venv-bot', '.work', '*.html', '.assistant-synthetic-test.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Proibição de checkout no MVP (CLAUDE.md regra 5).
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^(submitOrder|createAddress)$/]",
          message: 'Envio de pedidos e criação de endereços estão fora do escopo atual.',
        },
      ],
    },
  },
);
