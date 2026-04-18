module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/setupEnv.js'],
  setupFilesAfterEach: [],
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/helpers/globalTeardown.js',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  verbose: true,
  forceExit: true,
};
