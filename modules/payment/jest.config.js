/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.[jt]s', '**/*.crud.test.[jt]s'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
};
