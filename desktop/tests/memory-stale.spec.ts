import { test as memoryTest } from './memory-fixture';
import { MemoryHttpProxy } from './memory-http-proxy';
import { memoryNewestRefresh, memoryOwnerScopeStale, memoryScopeRoundTrip, memoryReconnect, memoryIndependentFailures, memorySectionFailure } from './memory-page-scenarios';

const test = memoryTest.extend<{ memoryProxy: MemoryHttpProxy }>({
  memoryBackendMode: 'reused',
  memoryProxy: [async ({ memoryBackend }, use) => {
    const proxy = await MemoryHttpProxy.attach(memoryBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`同一范围的新刷新不被旧读取的迟到${failure ? '失败' : '成功'}覆盖`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memoryNewestRefresh(await app.firstWindow(), memoryBackend, memoryProxy, failure);
});

for (const failure of [false, true]) test(`A→B→A 后旧资料读取的迟到${failure ? '失败' : '成功'}不覆盖新范围`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memoryScopeRoundTrip(await app.firstWindow(), memoryBackend, memoryProxy, failure);
});

for (const failure of [false, true]) test(`连接 generation 变化后旧资料读取的迟到${failure ? '失败' : '成功'}不恢复`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memoryReconnect(await app.firstWindow(), memoryBackend, memoryProxy, failure);
});

test('某栏失败不冒充空资料，其他栏可用，失败栏可以独立重读', async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memoryIndependentFailures(await app.firstWindow(), memoryBackend, memoryProxy);
});

for (const section of ['contact', 'owner', 'pending', 'sources'] as const) test(`${section} 栏的加载、失败与独立重读保持其他栏可用`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memorySectionFailure(await app.firstWindow(), memoryBackend, memoryProxy, section);
});

for (const failure of [false, true]) test(`切换联系人后本人资料的迟到${failure ? '失败' : '成功'}不恢复上一位资料`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  await memoryOwnerScopeStale(await app.firstWindow(), memoryBackend, memoryProxy, failure);
});
