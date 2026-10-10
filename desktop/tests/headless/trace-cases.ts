import { expect, type Browser, type Page } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment, withMemoryBackend, withTraceBackend, type TraceData } from './backend-fixture';
import { MemoryHttpProxy } from '../memory-http-proxy';

// 通过正式页面入口检查可见行为，不运行 Electron、微信或外部模型。
export async function memoryTraces(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => {
    await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const page = await host.open('manager');
        await page.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        await page.getByRole('button', { name: '关系资料', exact: true }).click();
        await expect(page.getByRole('region', { name: '提取与来源处理过程', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '查看提取过程：甲喜欢合成茉莉茶。', exact: true }).click();
        await expect(page.getByText('这条资料没有已保存的过程记录。', { exact: true })).toBeVisible();
      } finally { await host.close(); }
    });
  });
}

async function openMemory(page: Page) {
  await page.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await page.getByRole('button', { name: '关系资料', exact: true }).click();
}
async function showTrace(page: Page, data: TraceData) {
  await page.getByRole('button', { name: '查看提取过程：甲参加合成追踪活动。', exact: true }).click();
  await page.getByRole('button', { name: `查看批次：${data.trace_id}`, exact: true }).click();
  await page.getByText('1. 实际输入窗口', { exact: true }).click();
  await expect(page.getByRole('group', { name: '过程详情', exact: true }).getByText(/桌面验收合成文字/).first()).toBeVisible();
}

export async function memoryTracesFull(browser: Browser, origin: string) {
  await withTraceBackend(async (fixture, data) => {
    await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const page = await host.open('manager'); await openMemory(page);
        const panel = page.getByRole('region', { name: '提取与来源处理过程', exact: true });
        await page.getByRole('button', { name: '查看提取过程：本人手动录入的合成资料。', exact: true }).click();
        await expect(panel.getByText('手动录入资料不适用模型提取过程。', { exact: true })).toBeVisible();
        await panel.getByRole('button', { name: '查看批次列表', exact: true }).click();
        await expect(panel.getByRole('list', { name: '过程批次' }).getByRole('listitem')).toHaveCount(20);
        await panel.getByRole('button', { name: '读取更早批次', exact: true }).click();
        await expect(panel.getByRole('list', { name: '过程批次' }).getByRole('listitem')).toHaveCount(23);
        const zeroId = await page.evaluate(async (recordedId) => (await window.notalone.traces.getState()).batches.find((row) => row.status === 'succeeded' && row.batchId !== recordedId)!.batchId, data.trace_id);
        await panel.getByRole('button', { name: `查看批次：${zeroId}`, exact: true }).click();
        await panel.getByText(/批次结束与水位/).click();
        await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/"extracted": 0/)).toBeVisible();
        await showTrace(page, data);
        await panel.getByText(/采纳门槛/).click();
        await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/"passed": false/)).toBeVisible();
        await panel.getByRole('combobox', { name: '记录类型' }).selectOption('candidate');
        await panel.getByRole('textbox', { name: '记录标识' }).fill(data.trace_candidate_id);
        await panel.getByRole('button', { name: '查找记录过程' }).click();
        await expect(panel.getByRole('button', { name: `查看批次：${data.trace_id}`, exact: true })).toBeVisible();
        await panel.getByRole('combobox', { name: '记录类型' }).selectOption('message');
        await panel.getByRole('textbox', { name: '记录标识' }).fill(data.trace_message_id);
        await panel.getByRole('button', { name: '查找记录过程' }).click();
        await expect(panel.getByRole('listitem')).toHaveCount(23);
        const failedId = await page.evaluate(async () => (await window.notalone.traces.getState()).batches.find((row) => row.status === 'model_failed')!.batchId);
        await panel.getByRole('button', { name: `查看批次：${failedId}`, exact: true }).click();
        await panel.getByText('批次、重试与执行状态', { exact: true }).click();
        await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/"status": "model_failed"/)).toBeVisible();
        await showTrace(page, data);
        await panel.getByRole('button', { name: '删除这份过程记录', exact: true }).click();
        await panel.getByRole('button', { name: '确认删除过程', exact: true }).click();
        await expect(panel.getByText('过程记录已删除，权威记忆仍保留。', { exact: true })).toBeVisible();
        const authoritative = await fixture.readMemorySection(data.contact_ids[0], 'contact');
        expect((authoritative.data.memories as Array<{ memory_id: string }>).some((row) => row.memory_id === data.traced_memory_id)).toBe(true);
        await page.getByRole('button', { name: '查看提取过程：甲参加合成追踪活动。', exact: true }).click();
        await expect(panel.getByText('过程正文已删除，仅保留实际存在的状态与标识。', { exact: true })).toBeVisible();
        await panel.getByRole('combobox', { name: '过程类型' }).selectOption('source-processing-traces');
        await panel.getByRole('button', { name: '查看批次列表', exact: true }).click();
        await panel.getByRole('button', { name: `查看批次：${data.processing_id}`, exact: true }).click();
        await panel.getByText('1. 原始记录与规范化：saved', { exact: true }).click();
        await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/合成来源处理原文/)).toBeVisible();
        await panel.screenshot({ path: 'artifacts/headless-pages/memory-traces.png' });
        await panel.getByRole('combobox', { name: '记录类型' }).selectOption('source_document');
        await panel.getByRole('textbox', { name: '记录标识' }).fill(data.source_document_id);
        await panel.getByRole('button', { name: '查找记录过程' }).click();
        await expect(panel.getByRole('button', { name: `查看批次：${data.processing_id}`, exact: true })).toBeVisible();
        await page.getByRole('combobox', { name: '资料联系人' }).selectOption(data.empty_contact_id);
        await panel.getByRole('button', { name: '查看批次列表', exact: true }).click();
        await expect(panel.getByText('当前联系人没有已保存的批次。', { exact: true })).toBeVisible();
      } finally { await host.close(); }
    });
  });
}

export async function memoryTracesLifecycle(browser: Browser, origin: string) {
  await withTraceBackend(async (fixture, data) => {
    const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
    try {
      await withControllerEnvironment(fixture, async (userData) => {
        const host = new PageHost(await browser.newContext(), origin, userData);
        try {
          await host.backend.connect();
          const page = await host.open('manager'); await openMemory(page); await showTrace(page, data);
          const panel = page.getByRole('region', { name: '提取与来源处理过程', exact: true });
          const path = `/api/contacts/${data.contact_ids[0]}/memory-traces/${data.trace_id}`;
          proxy.failurePaths.add(path);
          await page.evaluate(async (id) => {
            const scope = await window.notalone.contacts.getState();
            await window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id });
          }, data.trace_id);
          await expect(panel.getByText('过程读取失败，请重试。', { exact: true })).toBeVisible();
          await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          proxy.failurePaths.delete(path);
          await showTrace(page, data);
          const rejected = await page.evaluate(async (outside) => {
            const scope = await window.notalone.contacts.getState();
            const common = { contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces' as const };
            const invalid = [{ ...common, contactId: outside }, { ...common, scopeRevision: scope.scopeRevision - 1 },
              { ...common, resource: 'http' }, { ...common, path: '/api/anything' }, { ...common, ownerId: outside }];
            return Promise.all(invalid.map(async (input) => { try { await window.notalone.traces.list(input as typeof common); return false; } catch { return true; } }));
          }, data.other_contact_id);
          expect(rejected).toEqual([true, true, true, true, true]);
          const helper = await host.open('helper');
          expect(await helper.evaluate(async () => { try { await window.notalone.traces.getState(); return false; } catch { return true; } })).toBe(true);
          await helper.evaluate(() => { (window as unknown as { traceEvents: number }).traceEvents = 0; window.notalone.traces.onStateChanged(() => { (window as unknown as { traceEvents: number }).traceEvents++; }); });
          proxy.holdPath = path;
          await page.evaluate((id) => {
            void window.notalone.contacts.getState().then((scope) => window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id }));
          }, data.trace_id);
          await expect.poll(() => proxy.heldCount).toBe(1);
          await page.getByRole('combobox', { name: '资料联系人' }).selectOption(data.contact_ids[1]);
          proxy.holdPath = null; proxy.release();
          expect(await page.evaluate(async () => (await window.notalone.traces.getState()).detail)).toBeNull();
          await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          await page.getByRole('combobox', { name: '资料联系人' }).selectOption(data.contact_ids[0]);
          await showTrace(page, data);
          proxy.failRuntimeStatus = true;
          await expect(page.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
          await expect(page.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          proxy.failRuntimeStatus = false;
          await page.getByRole('button', { name: '重试连接', exact: true }).click();
          await page.getByRole('combobox', { name: '资料联系人' }).selectOption(data.contact_ids[0]);
          await showTrace(page, data);
          proxy.holdPath = path;
          await page.evaluate((id) => {
            void window.notalone.contacts.getState().then((scope) => window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id }));
          }, data.trace_id);
          await expect.poll(() => proxy.heldCount).toBe(1);
          await page.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('button', { name: '删除来源', exact: true }).click();
          await page.getByRole('button', { name: '确认删除来源', exact: true }).click();
          await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          await expect(page.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
          proxy.holdPath = null; proxy.release();
          expect(await page.evaluate(async () => (await window.notalone.traces.getState()).detail)).toBeNull();
          await panel.getByRole('button', { name: '查看批次列表', exact: true }).click();
          await panel.getByRole('button', { name: `查看批次：${data.trace_id}`, exact: true }).click();
          await expect(panel.getByText('1. 实际输入窗口', { exact: true })).toHaveCount(0);
          await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/桌面验收合成文字/)).toHaveCount(0);
          await expect(panel.getByText('过程正文已删除，仅保留实际存在的状态与标识。', { exact: true })).toBeVisible();
          expect(await helper.evaluate(() => (window as unknown as { traceEvents: number }).traceEvents)).toBe(0);
        } finally { proxy.release(); await host.close(); }
      });
    } finally { await proxy.close(); }
  });
}
