module.exports = {
  globalSetup: '<rootDir>/jest/contract-test-setup.ts',
  globalTeardown: '<rootDir>/jest/contract-test-teardown.ts',
  testMatch: ['**/*.test.ts'],
  testEnvironment: 'node',
  testURL: 'http://localhost',
  preset: 'ts-jest',
  rootDir: '..',
  roots: ['test', 'src']
};
