import { test } from './binding-fixture';
import { bindingInitialSelection, bindingRevokeBusy, bindingMetadataStale, bindingFinalNameStale, bindingNoChannel, bindingCliUnavailable, bindingNamedArguments, bindingStableContacts, bindingReconfirm, bindingConcurrentNew, bindingRevokeWaiting } from './binding-page-scenarios';

test('首次没有选择，刷新只保留仍有效的手选，新会话不授权且不读正文', async ({ bindingPage }) => {
  await bindingInitialSelection(bindingPage);
});

test('等待本轮超时显示未撤销并保留重试，成功响应后实际 HTTP 检查不再新增 tail', async ({ bindingPage }) => {
  await bindingRevokeBusy(bindingPage);
});

test('元数据改名使旧手选失效，最终提交前失效或已绑定冲突不静默授权', async ({ bindingPage }) => {
  await bindingMetadataStale(bindingPage);
});

test('App 复读后服务端最终复读发生改名时整批拒绝，不部分新建联系人或授权', async ({ bindingPage }) => {
  await bindingFinalNameStale(bindingPage);
});

test.describe('本人渠道身份尚未确认', () => {
  test.use({ bindingMode: 'no-channel' });
  test('真实同步接口不可用时引导先单联系人历史导入，不伪装就绪', async ({ bindingPage }) => {
    await bindingNoChannel(bindingPage);
  });
});

test('已授权目录在 CLI 不可用时仍能撤销，新增范围诚实显示不可用', async ({ bindingPage }) => {
  await bindingCliUnavailable(bindingPage);
});

test('明确新建联系人后才写入，受限具名桥接拒绝零选择、额外参数、跨范围和小窗变更', async ({ bindingPage }) => {
  await bindingNamedArguments(bindingPage);
});

test('按稳定标识明确选择同名联系人，最终确认只追加授权，已开总开关时新增范围立即可读', async ({ bindingPage }) => {
  await bindingStableContacts(bindingPage);
});

test('改名与列表消失如实保留授权，用户明确撤销后重新确认才产生新绑定', async ({ bindingPage }) => {
  await bindingReconfirm(bindingPage);
});

test('撤销等待本轮结束后成功，后续检查不再新增读取', async ({ bindingPage }) => {
  await bindingRevokeWaiting(bindingPage);
});

test('并发新建的旧选择公开拒绝且不部分创建联系人或扩大读取', async ({ bindingPage, bindingProxy }) => {
  await bindingConcurrentNew(bindingPage, bindingProxy);
});
