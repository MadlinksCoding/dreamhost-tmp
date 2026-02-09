/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/*.test.[jt]s',
    '**/*.jest.tests.[jt]s',
    '**/*.int.test.[jt]s',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
};
