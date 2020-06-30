module.exports = {
  collectCoverage: true,
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/?(*.)(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/']
};
