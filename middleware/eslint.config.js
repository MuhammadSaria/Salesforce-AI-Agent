export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', setImmediate: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', structuredClone: 'readonly' } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-binary-expression': 'error'
    }
  }
];
