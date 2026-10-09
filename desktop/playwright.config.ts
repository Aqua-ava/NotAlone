import { defineConfig } from '@playwright/test';
import './tests/app-test-gate';
import path from 'node:path';

const acceptedFiles: string[] = JSON.parse(process.env.NOTALONE_APP_TEST_FILES || '[]');
if (!Array.isArray(acceptedFiles) || acceptedFiles.some((file) => typeof file !== 'string' || !/^tests\/[\w-]+\.spec\.ts$/.test(file))) {
  throw new Error('app_test_arguments: 测试范围不可核验');
}

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/scheduling/**',
  testMatch: acceptedFiles.length ? acceptedFiles.map((file) => path.resolve(file)) : '**/*.spec.ts',
  globalSetup: './tests/app-test-gate.ts',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
});
