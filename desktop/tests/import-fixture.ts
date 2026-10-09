import path from 'node:path';
import { test as appTest } from './app-fixture';
import { withImportFixture, type ImportFixture } from './import-backend-fixture';
export { ImportFixture } from './import-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ importBackend: ImportFixture }>({
  importBackend: async ({}, use) => { await withImportFixture('notalone-import-app-', use); },
  appEnvironment: async ({ importBackend }, use) => { await use(importBackend.environment()); },
  launchConfiguration: async ({ importBackend }, use) => { await use({ pythonExecutable: importBackend.pythonExecutable,
    projectDirectory: project, envFilePath: importBackend.envPath, backendInfoPath: importBackend.infoPath }); },
});
