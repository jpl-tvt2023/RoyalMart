module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/setupEnv.js'],
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/helpers/globalTeardown.js',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Every test here drives the real HTTP stack against a hosted (Turso) DB, so
  // a single test routinely makes a dozen sequential network round trips.
  // Jest's 5s default is tuned for pure-unit work and tips over whenever the
  // network is slow -- which showed up as different tests failing on different
  // runs, looking like flaky logic rather than latency. Raise the floor once
  // here instead of sprinkling per-test timeouts.
  testTimeout: 30000,
  verbose: true,
  forceExit: true,
};
