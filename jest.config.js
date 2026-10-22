module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/env.ts'],
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/db/seed.ts', '!src/db/migrate.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
