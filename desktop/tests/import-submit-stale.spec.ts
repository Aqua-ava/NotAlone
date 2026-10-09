import { test as importTest } from './import-fixture';
import { importAppPages } from './import-app-actions';
import { staleImportViewing, staleImportContact, staleImportConnection, lostImportResponse } from './import-page-scenarios';
import { ContactHttpProxy } from './contact-http-proxy';

const test = importTest.extend<{ importProxy: ContactHttpProxy }>({
  importProxy: [async ({ importBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(importBackend.infoPath, '/api/imports/commit');
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`停止查看后迟到的保存${failure ? '失败' : '成功'}不能恢复确认，已保存资料经真实目录核验`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const pages = await importAppPages(app, importBackend);
  await staleImportViewing({ ...pages, importProxy }, failure);
});

for (const failure of [false, true]) test(`另一窗口换联系人后迟到的保存${failure ? '失败' : '成功'}不污染当前范围`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const pages = await importAppPages(app, importBackend);
  await staleImportContact({ ...pages, importProxy }, failure);
});

for (const failure of [false, true]) test(`换连接后迟到的保存${failure ? '失败' : '成功'}不恢复原任务页面`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const pages = await importAppPages(app, importBackend);
  await staleImportConnection({ ...pages, importProxy }, failure);
});

test('保存响应丢失不假称回滚或自动重发，重新预览确认后恢复同一真实来源', async ({ runningApp: { app }, importBackend, importProxy }) => {
  const pages = await importAppPages(app, importBackend);
  await lostImportResponse({ ...pages, importProxy });
});
