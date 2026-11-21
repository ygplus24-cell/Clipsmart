import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'dev-dist/**/*', 'node_modules/**/*', 'src/**/*', 'server/**/*', 'server.ts', 'vite.config.ts'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
