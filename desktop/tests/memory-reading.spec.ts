import { test } from './memory-fixture';
import { memoryDetails, memoryScopeAndEmpty, memoryNamedArguments } from './memory-page-scenarios';

// 普通页面断言共用于实际 App 与受限无头入口；原生能力仍须单独验收。
test('按已选联系人显示真实有效资料、当前联系人相关的本人资料与未确认候选', async ({ runningApp: { app }, memoryBackend }) => {
  await memoryDetails(await app.firstWindow(), memoryBackend);
});

test('空资料明确可见，切换不显示上一位联系人的资料，本人资料也随联系人切换', async ({ runningApp: { app }, memoryBackend }) => {
  await memoryScopeAndEmpty(await app.firstWindow(), memoryBackend);
});

test('具名读取拒绝目录外、旧范围和多余参数，渲染层没有通用请求或认证信息', async ({ runningApp: { app }, memoryBackend }) => {
  await memoryNamedArguments(await app.firstWindow(), memoryBackend);
});
