/** Root Jest config for dreamhost-tmp (tokenRegistry, payment, etc.) */
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['**/test/**/*.test.js', '**/test/**/*.tests.js', '**/test/**/*.jest.tests.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/databases/',
    'tokenManager\\.test\\.js$', // Node native test runner only (node --test)
    'tokenManager\\.int\\.test\\.js$', // Run with npm run test:token-manager-int when ScyllaDB is up
  ],
  modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
  transform: {},
  verbose: true,
};
