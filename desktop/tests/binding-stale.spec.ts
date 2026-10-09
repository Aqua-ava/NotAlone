import { test as bindingTest } from './binding-fixture';
import { ContactHttpProxy } from './contact-http-proxy';
import { bindingReconnect } from './binding-page-scenarios';

const test = bindingTest.extend<{ bindingProxy: ContactHttpProxy }>({
  bindingProxy: [async ({ bindingBackend }, use) => {
    await bindingBackend.startBackend();
    const proxy = await ContactHttpProxy.attach(bindingBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`连接失效后旧授权响应的迟到${failure ? '失败' : '成功'}不覆盖新范围或手选`, async ({ bindingPage, bindingProxy }) => {
  await bindingReconnect(bindingPage, bindingProxy, failure);
});
