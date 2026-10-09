import { test } from './binding-fixture';
import { bindingReconnect } from './binding-page-scenarios';

for (const failure of [false, true]) test(`连接失效后旧授权响应的迟到${failure ? '失败' : '成功'}不覆盖新范围或手选`, async ({ bindingPage, bindingProxy }) => {
  await bindingReconnect(bindingPage, bindingProxy, failure);
});
