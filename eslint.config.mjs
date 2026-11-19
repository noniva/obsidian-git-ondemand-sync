import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Disabled: minAppVersion is 1.4.0 and obsidian@^1.7.2 predates 1.13.0+ getSettingDefinitions().
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
);
