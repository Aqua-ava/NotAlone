import path from 'node:path';
import { test as appTest } from './app-fixture';
import { withBindingFixture, type BindingFixture, type BindingMode } from './binding-backend-fixture';
import type { BindingPage } from './binding-page-scenarios';
import { ContactHttpProxy } from './contact-http-proxy';
export { BindingFixture, initialCliState, type CliState } from './binding-backend-fixture';
const project = path.resolve('..');

export const test = appTest.extend<{ bindingBackend: BindingFixture; bindingMode: BindingMode; bindingPage: BindingPage; bindingProxy: ContactHttpProxy }>({
  bindingMode: ['ready', { option: true }],
  bindingBackend: async ({ bindingMode }, use) => {
    await withBindingFixture('notalone-binding-app-', bindingMode, async (fixture) => {
      await fixture.startBackend();
      await use(fixture);
    });
  },
  bindingProxy: [async ({ bindingBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(bindingBackend.infoPath);
    try { await use(proxy); }
    finally {
      // 依赖此代理的 App 夹具已完成原 app.close；先保留真实响应见证，再回收传输。
      if (proxy.authenticatedRuntimeStopped) bindingBackend.confirmProxyStopped();
      proxy.release();
      try { await proxy.close(); }
      catch (error) { bindingBackend.recordUnconfirmedCleanup('http-proxy'); throw error; }
    }
  }, { auto: true }],
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
  // 显式依赖代理，保证 App 连接前独立握手已经指向本轮可观察的真实传输。
  appEnvironment: async ({ bindingBackend, bindingProxy }, use) => { await use(bindingBackend.environment()); },
  launchConfiguration: async ({ bindingBackend }, use) => { await use({ pythonExecutable: bindingBackend.pythonExecutable,
    projectDirectory: project, envFilePath: bindingBackend.envPath, backendInfoPath: bindingBackend.infoPath }); },
});
