import { selectContact } from '../contact-picker-actions.mjs';
import { expandMemoryMore, openDeveloperTraces, openImportManagement, openMemoryTrace, selectMemoryCategory } from '../memory-page-actions';
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
        await selectContact(page.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
        await page.getByRole('button', { name: '记忆', exact: true }).click();
        await openMemoryTrace(page, '甲喜欢合成茉莉茶。');
        await expect(page.getByRole('region', { name: '提取与来源处理过程', exact: true })).toBeVisible();
        await expect(page.getByText('这条资料没有已保存的过程记录。', { exact: true })).toBeVisible();
      } finally { await host.close(); }
    });
  });
}

async function openMemory(page: Page) {
  await selectContact(page.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await page.getByRole('button', { name: '记忆', exact: true }).click();
}
async function showTrace(page: Page, data: TraceData) {
  await openMemoryTrace(page, '甲参加合成追踪活动。');
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
        await page.getByRole('button', { name: '查看依据：甲参加合成追踪活动。', exact: true }).click();
        const evidence = page.getByRole('region', { name: '记忆依据', exact: true });
        await expect(evidence.locator('blockquote').first()).toContainText('桌面验收合成文字');
        await expect(panel).toHaveCount(0);
        await expect(evidence.getByRole('textbox', { name: '记录标识' })).toHaveCount(0);
        await evidence.getByRole('button', { name: '收起依据', exact: true }).click();
        // 全局本人手录不属于当前联系人；用当前联系人手录资料核对不适用提取过程。
        await openMemoryTrace(page, '甲的新版本关系备注。');
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
        // 原始上下文未知时先进入人工复核，追踪须如实显示未执行采纳门槛。
        const candidateSummary = panel.getByText('候选处理结果', { exact: true });
        await candidateSummary.click();
        const details = candidateSummary.locator('..');
        await expect(details.getByText(/"disposition": "pending_correction_review"/)).toBeVisible();
        await expect(details.getByText(/"not_executed": \[[\s\S]*"adoption_gates"/)).toBeVisible();
        await expect(panel.getByText(/\d+\. 采纳门槛$/)).toHaveCount(0);
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
        await openMemoryTrace(page, '甲参加合成追踪活动。');
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
        await page.getByRole('combobox', { name: '调试联系人' }).selectOption(data.empty_contact_id);
        await openDeveloperTraces(page);
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
          await page.getByRole('combobox', { name: '调试联系人' }).selectOption(data.contact_ids[1]);
          proxy.holdPath = null; proxy.release();
          expect(await page.evaluate(async () => (await window.notalone.traces.getState()).detail)).toBeNull();
          await openDeveloperTraces(page);
          await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          await page.getByRole('combobox', { name: '调试联系人' }).selectOption(data.contact_ids[0]);
          await showTrace(page, data);
          proxy.failRuntimeStatus = true;
          await expect(page.getByRole('combobox', { name: '调试联系人' })).toBeDisabled();
          await expect(page.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          proxy.failRuntimeStatus = false;
          await page.getByRole('button', { name: '重试连接', exact: true }).click();
          await page.getByRole('combobox', { name: '调试联系人' }).selectOption(data.contact_ids[0]);
          await showTrace(page, data);
          proxy.holdPath = path;
          await page.evaluate((id) => {
            void window.notalone.contacts.getState().then((scope) => window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id }));
          }, data.trace_id);
          await expect.poll(() => proxy.heldCount).toBe(1);
          await openImportManagement(page);
          await page.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${data.source_document_id}"]`).getByRole('button', { name: '删除来源', exact: true }).click();
          await page.getByRole('button', { name: '确认删除来源', exact: true }).click();
          await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
          await expect(page.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
          proxy.holdPath = null; proxy.release();
          expect(await page.evaluate(async () => (await window.notalone.traces.getState()).detail)).toBeNull();
          await openDeveloperTraces(page);
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

export async function memoryTracesRecordDeletion(browser: Browser, origin: string) {
  for (const mode of ['deletion-contact', 'deletion-owner', 'deletion-candidate', 'deletion-contact-late', 'deletion-contact-unknown'] as const) {
    await withTraceBackend(async (fixture, data) => {
      const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
      try {
        await withControllerEnvironment(fixture, async (userData) => {
          const host = new PageHost(await browser.newContext(), origin, userData);
          try {
            await host.backend.connect();
            const page = await host.open('manager'); await openMemory(page);
            const category = mode === 'deletion-owner' ? '本人记忆' : mode === 'deletion-candidate' ? '待确认候选' : '联系人记忆';
            await openMemoryTrace(page, data.trace_text, category);
            await page.getByRole('button', { name: `查看批次：${data.trace_id}`, exact: true }).click();
            const panel = page.getByRole('region', { name: '提取与来源处理过程', exact: true });
            await panel.getByText('1. 实际输入窗口', { exact: true }).click();
            await expect(panel.getByRole('group', { name: '过程详情', exact: true }).getByText(/桌面验收合成文字/).first()).toBeVisible();
            const late = mode.endsWith('-late');
            if (late) {
              proxy.holdPath = `/api/contacts/${data.contact_ids[0]}/memory-traces/${data.trace_id}`;
              await page.evaluate((id) => {
                void window.notalone.contacts.getState().then((scope) => window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id }));
              }, data.trace_id);
              await expect.poll(() => proxy.heldCount).toBe(1);
            }
            const candidate = mode === 'deletion-candidate';
            const unknown = mode.endsWith('-unknown');
            if (unknown) {
              proxy.holdMethod = 'POST';
              proxy.holdPath = `/api/contacts/${data.contact_ids[0]}/memories/${data.traced_memory_id}/delete`;
            }
            await selectMemoryCategory(page, category);
            const card = page.getByRole('article').filter({ has: page.getByText(data.trace_text, { exact: true }) });
            if (!late && !unknown) {
              await card.getByRole('button', { name: `查看依据：${data.trace_text}`, exact: true }).click();
              await expect(page.getByRole('region', { name: '记忆依据', exact: true }).locator('blockquote').first()).toBeVisible();
            }
            if (!candidate) await expandMemoryMore(card);
            await card.getByRole('button', { name: `${candidate ? '丢弃候选' : '删除资料'}：${data.trace_text}`, exact: true }).click();
            await card.getByRole('button', { name: candidate ? '确认丢弃' : '确认删除', exact: true }).click();
            if (unknown) {
              await expect.poll(() => proxy.heldCount).toBe(1);
              expect(await page.evaluate(async (id) => {
                const scope = await window.notalone.contacts.getState();
                return window.notalone.traces.show({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision, resource: 'memory-traces', batchId: id })
                  .then(() => false, () => true);
              }, data.trace_id)).toBe(true);
              proxy.holdPath = null; proxy.release(true);
              await expect(page.getByText('未能完成资料操作与核对，请刷新确认后重试。', { exact: true })).toBeVisible();
            } else {
              await expect(card).toHaveCount(0);
              const evidence = page.getByRole('region', { name: '记忆依据', exact: true });
              await expect(evidence.getByText(data.trace_text, { exact: true })).toHaveCount(0);
              await expect(evidence.locator('blockquote')).toHaveCount(0);
            }
            await openDeveloperTraces(page);
            await expect(panel.getByRole('group', { name: '过程详情', exact: true })).toHaveCount(0);
            if (late) { proxy.holdPath = null; proxy.release(); }
            expect(await page.evaluate(async () => (await window.notalone.traces.getState()).detail)).toBeNull();
            // 卡片撤下早于资料删除核对结束；等正式收尾通知解除过程读取门禁。
            await expect(panel.getByText('资料操作已结束，请重新读取过程并确认删除结果。', { exact: true })).toBeVisible();
            await panel.getByRole('button', { name: '查看批次列表', exact: true }).click();
            await panel.getByRole('button', { name: `查看批次：${data.trace_id}`, exact: true }).click();
            await expect(panel.getByText('过程正文已删除，仅保留实际存在的状态与标识。', { exact: true })).toBeVisible();
            await expect(panel.getByText(/桌面验收合成文字/)).toHaveCount(0);
          } finally { proxy.release(); await host.close(); }
        });
      } finally { await proxy.close(); }
    }, mode === 'deletion-contact-late' || mode === 'deletion-contact-unknown' ? 'deletion-contact' : mode);
    process.stdout.write(`page_test_scenario_passed: trace-${mode}\n`);
  }
}
