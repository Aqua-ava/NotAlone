import { setWorkspaceContext } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { openImportManagement } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withReplyOverviewFixture, replyOverviewModules, type ReplyOverviewPrepared } from '../overview-reply-retrieval-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 仅由现有有限调度器的单Chrome入口调用；准备及生成走自有库的真实HTTP。
export async function overviewReplyRetrieval(browser: Browser, origin: string) {
  const released = ownResource();
  await withReplyOverviewFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('reply_overview_prepared') as ReplyOverviewPrepared;
    process.env.NOTALONE_TEST_DATABASE_URL = fixture.data.database_url;
    const proof = await fixture.command('runtime_proof');
    expect(proof.environment_verified).toBe(true);
    expect(proof.critical_module_count).toBe(Object.keys(replyOverviewModules).length);
    expect(proof.external_model_attempts).toBe(0);
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager'), opened = manager.context().waitForEvent('page');
      await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
      const helper = await opened;
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(prepared.contactId);
      await confirmHelperContact(helper, prepared.contactId);
      const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
      const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
      async function expectEvidenceArticle(kind: string, text: string) {
        const article = evidence.getByRole('article')
          .filter({ has: helper.getByText(kind, { exact: true }) })
          .filter({ has: helper.getByText(text, { exact: true }) });
        await expect(article).toHaveCount(1);
        await expect(article).toBeVisible();
        const body = article.getByText(text, { exact: true });
        await expect(body).toHaveCount(1);
        await expect(body).toBeVisible();
        const metadata = article.locator('.record-metadata');
        if (await metadata.getAttribute('open') === null) await metadata.locator('summary').click();
        return article;
      }
      async function generate(draft: string, text: string, background: boolean, kinds?: string[]) {
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
        await setWorkspaceContext(helper, background);
        await fixture.command('plan', { plan: { text, basis: '只依实际资料提问，未核实处保持未知。',
          ...(kinds ? { cite_kinds: kinds } : {}) } });
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(editor).toHaveValue(text);
        await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
        await evidence.locator('.evidence-technical > summary').click();
      }

      const first = '想问问现在适不适合一起散步？';
      await generate(prepared.draft, first, true, ['confirmed_memory', 'owner_memory', 'pending_candidate', 'message']);
      await expect(evidence.getByText('本次已完成有界检索。', { exact: true })).toBeVisible();
      await expectEvidenceArticle('消息', prepared.rawText);
      const history = await expectEvidenceArticle('关系资料', prepared.history.text);
      const unknown = await expectEvidenceArticle('关系资料', prepared.unknown.text);
      await expectEvidenceArticle('关系资料', prepared.manualContact.text);
      for (const memory of [prepared.manualOwner, prepared.self, prepared.otherSelf]) {
        await expectEvidenceArticle('本人资料', memory.text);
      }
      await expect(history.getByText('生成时适用性：历史资料；不能据此认定当前情况', { exact: true })).toBeVisible();
      await expect(unknown.getByText('生成时适用性：是否仍适用，尚不确定', { exact: true })).toBeVisible();
      const pending = await expectEvidenceArticle('未确认记忆候选', prepared.pending.text);
      await expect(pending.getByText('未确认记忆候选', { exact: true })).toBeVisible();
      await expect(pending.getByText('生成时状态：待确认', { exact: true })).toBeVisible();
      await expect(evidence.getByText('由联系人概览定位，底层资料来历：手动录入。', { exact: true })).toBeVisible();
      await expect(evidence.getByText('由本人概览定位，底层资料来历：来源支持。', { exact: true })).toHaveCount(2);
      await expect(evidence.getByText(/原话补查：.*估算 token/)).toBeVisible();
      await expect(helper.getByText(prepared.otherPrivateText, { exact: true })).toHaveCount(0);
      const originalReceipt = await helper.evaluate(() => window.notalone.replies.getEvidenceState());

      const edit = '用户已修改：先问安排，暂不承诺。';
      await editor.fill(edit);
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(prepared.contactId);
      await manager.getByRole('button', { name: '刷新记忆', exact: true }).click();
      const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
      await contact.getByRole('button', { name: `修正资料：${prepared.manualContact.text}`, exact: true }).click();
      const correction = contact.getByRole('form', { name: '修正联系人资料', exact: true });
      const corrected = '对方明确更正为短程散步。';
      await correction.getByRole('textbox', { name: '资料正文', exact: true }).fill(corrected);
      await correction.getByRole('button', { name: '保存修正', exact: true }).click();
      await expect(contact.getByRole('button', { name: `修正资料：${corrected}`, exact: true })).toBeVisible();
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await expandSavedDiscussion(helper);
      await expect(editor).toHaveValue(edit);
      const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
      await expect(discussion.getByText('依据已变化', { exact: true })).toBeVisible();
      const current = await helper.evaluate(() => window.notalone.replies.getState());
      const candidate = current.result!.candidates[0].original;
      await helper.evaluate(({ replyRequestId, candidateId }) => {
        const read = async () => {
          const scope = await window.notalone.contacts.getState();
          await window.notalone.replies.loadEvidence({ contactId: scope.selectedContactId!, scopeRevision: scope.scopeRevision,
            replyRequestId, candidateId });
        };
        return read();
      }, { replyRequestId: current.result!.replyRequestId, candidateId: candidate.candidateId });
      await expectEvidenceArticle('关系资料', prepared.manualContact.text);
      const originalAgain = await helper.evaluate(() => window.notalone.replies.getEvidenceState());
      expect(originalAgain.retrieval?.overviewRevisions.contact?.projectionRevision)
        .toBe(originalReceipt.retrieval?.overviewRevisions.contact?.projectionRevision);
      expect((await fixture.command('observations')).model_calls).toBe(1);

      await openImportManagement(manager);
      const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${prepared.sourceToDelete}"]`);
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await expandSavedDiscussion(helper);
      await expect(discussion.getByText('相关来源已删除', { exact: true })).toBeVisible();
      await expect(editor).toHaveCount(0);
      await expect(helper.getByText(prepared.rawText, { exact: true })).toHaveCount(0);
      await expect(helper.getByText(first, { exact: true })).toHaveCount(0);
      await expect(helper.getByText(edit, { exact: true })).toHaveCount(0);

      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(prepared.emptyContactId);
      await confirmHelperContact(helper, prepared.emptyContactId);
      await generate('桉树彗星。', '只把这句话整理清楚。', true);
      await expect(evidence.getByText('本次检索未查到相关依据；不表示没有这件事。', { exact: true })).toBeVisible();
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(prepared.contactId);
      await confirmHelperContact(helper, prepared.contactId);
      await fixture.command('more_related');
      await generate(prepared.draft, '先询问当前散步安排。', true, ['confirmed_memory', 'owner_memory', 'pending_candidate']);
      await expect(evidence.getByText('本次检索预算已耗尽，未查到的内容仍为未知。', { exact: true })).toBeVisible();
      await expect(evidence.getByText(/联系人资料：.*预算已耗尽/)).toBeVisible();
      await expect(evidence.getByText(/本人资料：.*预算已耗尽/)).toBeVisible();
      await expect(evidence.getByText(/未确认参考：.*预算已耗尽/)).toBeVisible();
      await generate('只整理用户这句话。', '保留用户自己的意思。', false);
      await expect(evidence.getByText('本次快照未记录检索过程，不能据此判断是否查空或耗尽。', { exact: true })).toBeVisible();
      await expect(evidence.getByText('本次检索预算已耗尽，未查到的内容仍为未知。', { exact: true })).toHaveCount(0);
      const finalProof = await fixture.command('runtime_proof');
      expect(finalProof.external_model_attempts).toBe(0); expect(finalProof.model_calls).toBe(4);
    } finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: overview-reply-actual-evidence-unknown-budgets-revision-and-source-deletion\n');
}
