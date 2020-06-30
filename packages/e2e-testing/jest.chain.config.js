const config = require('./jest.config');
config.setupFilesAfterEnv = [];
config.globalSetup = '<rootDir>/chain-setup.ts';
config.globalTeardown = '<rootDir>/test-teardown.ts';
module.exports = config;
