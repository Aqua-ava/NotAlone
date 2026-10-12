import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { test as appTest } from './app-fixture';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';
export { RewriteFixture, type ModelPlan } from './rewrite-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ rewriteBackend: RewriteFixture }>({
  rewriteBackend: async ({}, use) => {
    await withRewriteFixture('notalone-rewrite-', async (fixture) => {
      await writeFile(appTest.info().outputPath('rewrite-owned.json'), JSON.stringify({
        childPid: fixture.child.pid, fixtureDirectory: fixture.directory,
        databaseName: /(?:^|\s)dbname=(notalone_core_flow_[0-9a-f]{32}_test)(?:\s|$)/.exec(fixture.data.database_url)?.[1] ?? null,
      }), { mode: 0o600, flag: 'wx' });
      await use(fixture);
    });
  },
  appEnvironment: async ({ rewriteBackend }, use) => { await use(rewriteBackend.environment()); },
  launchConfiguration: async ({ rewriteBackend }, use) => {
    await use({ pythonExecutable: rewriteBackend.pythonExecutable, projectDirectory: project,
      envFilePath: rewriteBackend.envPath, backendInfoPath: rewriteBackend.infoPath });
  },
});
