module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  transform: {
    '^.+\\.js$': 'babel-jest'
  },
  transformIgnorePatterns: [],
  moduleFileExtensions: ['js'],
  roots: ['<rootDir>'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {}
};
