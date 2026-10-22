import { selectContact } from '../contact-picker-actions.mjs';
import { expandMemoryDetails, openImportManagement, selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import type { ContactDatabase } from '../contact-backend-fixture';
import { SourceDeletionFixture } from '../source-deletion-fixture';
import { withSyntheticBackendFixture } from '../synthetic-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

type CorrectionDatabase = ContactDatabase & {
  old_source_id: string; fresh_source_id: string; wrong_memory_id: string;
  late_candidate_id: string; fresh_candidate_id: string;
};

export async function memoryCorrectionProtection(browser: Browser, origin: string) {
  const released = ownResource();
  try {
    await withSyntheticBackendFixture<CorrectionDatabase, SourceDeletionFixture>({
      directoryPrefix: 'notalone-headless-correction-', databaseScript: path.resolve('tests/fixtures/memory-correction-database.py'),
      createArguments: [], prepareTimeoutMs: 70_000, reuseBackend: true,
      createFixture: (directory, python, data) => new SourceDeletionFixture(directory, python, data),
    }, async (fixture) => withControllerEnvironment(fixture, async (userData) => {
      const data = fixture.data as CorrectionDatabase;
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
        await manager.getByRole('button', { name: '记忆', exact: true }).click();
        const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
        const pending = manager.getByRole('region', { name: '待确认候选', exact: true });
        await selectMemoryCategory(manager, '待确认候选');
        await expect(pending.getByText('甲偏爱合成咖啡。', { exact: true })).toBeVisible();
        await selectMemoryCategory(manager, '联系人记忆');
        await contact.getByRole('button', { name: '修正资料：甲喜欢合成咖啡。', exact: true }).click();
        const form = contact.getByRole('form', { name: '修正联系人资料', exact: true });
        await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('甲喝合成咖啡只是工作需要。');
        await form.getByRole('button', { name: '保存修正', exact: true }).click();
        await expect(contact.getByText('甲喝合成咖啡只是工作需要。', { exact: true })).toBeVisible();
        await selectMemoryCategory(manager, '待确认候选');
        await expect(pending.getByText('甲偏爱合成咖啡。', { exact: true })).toHaveCount(0);
        await expect(pending.getByText('新证据涉及此前人工决定，请展开详情核对。', { exact: true })).toBeVisible();
        await expect(pending.getByRole('group', { name: '新证据与原人工决定', exact: true })).toHaveCount(0);
        await expandMemoryDetails(pending.getByRole('article').filter({ has: manager.getByText('甲喜欢合成咖啡。', { exact: true }) }));
        const comparison = pending.getByRole('group', { name: '新证据与原人工决定', exact: true });
        await expect(comparison.getByText('原主张：甲喜欢合成咖啡。', { exact: true })).toBeVisible();
        await expect(comparison.getByText('原人工修正：甲喝合成咖啡只是工作需要。', { exact: true })).toBeVisible();
        await expect(comparison.getByText(`来源引用：${data.fresh_source_id}`, { exact: true })).toBeVisible();
        await pending.getByRole('button', { name: '确认并保存：甲喜欢合成咖啡。', exact: true }).click();
        await expect(pending.getByRole('article')).toHaveCount(0);
        await selectMemoryCategory(manager, '联系人记忆');
        await expect(contact.getByText('甲喜欢合成咖啡。', { exact: true })).toBeVisible();
        await expect(contact.getByText('甲喝合成咖啡只是工作需要。', { exact: true })).toBeVisible();
        const actual = await fixture.http(`/api/contacts/${data.contact_ids[0]}/memories`);
        expect((actual.data.memories as Array<Record<string, unknown>>).map((item) => item.adoption_method)).toEqual(['manual', 'manual']);
        await openImportManagement(manager);
        const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${data.old_source_id}"]`);
        await source.getByRole('button', { name: '删除来源', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
        await selectMemoryCategory(manager, '联系人记忆');
        await expect(contact.getByRole('article')).toHaveCount(0);
        await selectMemoryCategory(manager, '待确认候选');
        await expect(manager.getByRole('group', { name: '新证据与原人工决定', exact: true })).toHaveCount(0);
        expect((await fixture.http(`/api/contacts/${data.contact_ids[0]}/memories`)).data.memories).toEqual([]);
        expect((await fixture.http(`/api/contacts/${data.contact_ids[0]}/memory-candidates`)).data.candidates).toEqual([]);
      } finally { await host.close(); fixture.confirmControllerStopped(); }
    }));
  } finally { released(); }
}
