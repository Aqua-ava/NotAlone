import path from 'node:path';
import { test as appTest } from './app-fixture';
import { withBindingFixture, type BindingFixture, type BindingMode } from './binding-backend-fixture';
import type { BindingPage } from './binding-page-scenarios';
export { BindingFixture, initialCliState, type CliState } from './binding-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ bindingBackend: BindingFixture; bindingMode: BindingMode; bindingPage: BindingPage }>({
  bindingMode: ['ready', { option: true }],
  bindingBackend: async ({ bindingMode }, use) => {
    await withBindingFixture('notalone-binding-app-', bindingMode, use);
  },
  bindingPage: async ({ runningApp: { app }, bindingBackend }, use) => {
    const manager = await app.firstWindow();
    await use({ manager, bindingBackend,
      screenshot: (name) => manager.screenshot({ path: appTest.info().outputPath(name) }).then(() => undefined),
      async openHelper() {
        const opened = app.waitForEvent('window');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        return opened;
      },
    });
  },
  appEnvironment: async ({ bindingBackend }, use) => { await use(bindingBackend.environment()); },
  launchConfiguration: async ({ bindingBackend }, use) => { await use({ pythonExecutable: bindingBackend.pythonExecutable,
    projectDirectory: project, envFilePath: bindingBackend.envPath, backendInfoPath: bindingBackend.infoPath }); },
});
