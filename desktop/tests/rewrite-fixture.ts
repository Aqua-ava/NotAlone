import path from 'node:path';
import { test as appTest } from './app-fixture';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';
export { RewriteFixture, type ModelPlan } from './rewrite-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ rewriteBackend: RewriteFixture }>({
  rewriteBackend: async ({}, use) => {
    await withRewriteFixture('notalone-rewrite-', use);
  },
  appEnvironment: async ({ rewriteBackend }, use) => { await use(rewriteBackend.environment()); },
  launchConfiguration: async ({ rewriteBackend }, use) => {
    await use({ pythonExecutable: rewriteBackend.pythonExecutable, projectDirectory: project,
      envFilePath: rewriteBackend.envPath, backendInfoPath: rewriteBackend.infoPath });
  },
});
