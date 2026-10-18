import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 前半资料经同库公开 HTTP 准备；以下人工决定必须由生产 React 控件提交。
export async function memorySkillEvolution(browser: Browser, origin: string) {
  const released = ownResource();
  await withRewriteFixture('notalone-evolution-pages-', async fixture => withControllerEnvironment(fixture, async userData => {
    const prepared = await fixture.command('prepared') as {
      source_id: string; contact_text: string; owner_text: string; draft_id: string;
    };
    let host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      let manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成演进甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '联系人概览');
      await expect(manager.getByRole('region', { name: '联系人经历与关系变化', exact: true })
        .getByText(prepared.contact_text, { exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '本人概览');
      await expect(manager.getByRole('region', { name: '本人事实与偏好概览', exact: true })
        .getByText(prepared.owner_text, { exact: true })).toBeVisible();
      await manager.getByRole('button', { name: 'Skill 待审核', exact: true }).click();
      const learning = manager.getByRole('region', { name: 'Skill待审核', exact: true });
      await expect(learning.getByRole('article')).toHaveCount(1);
      await learning.getByRole('button', { name: '关闭经验整理', exact: true }).click();
      await expect(learning.getByRole('button', { name: '开启此联系人的经验整理', exact: true })).toBeVisible();
      await learning.getByRole('button', { name: '打开对照审核', exact: true }).click();
      const review = manager.getByRole('region', { name: 'Skill对照审核', exact: true });
      await review.getByRole('textbox', { name: '对照来话', exact: true }).fill('合成审核情境：如何核对饮茶安排？');
      await review.getByRole('textbox', { name: '当前意图与约束', exact: true }).fill('先说明自己的边界，不替双方作承诺');
      await review.getByRole('textbox', { name: '精确场景', exact: true }).fill('核对安排');
      await review.getByRole('combobox', { name: '适用范围', exact: true }).selectOption('owner');
      await review.getByRole('button', { name: '相同输入生成对照', exact: true }).click();
      const comparison = review.getByRole('region', { name: '冻结输入对照', exact: true });
      await expect(comparison.getByText('我先说明一下想法。', { exact: true })).toBeVisible();
      await expect(comparison.getByText('先核对一下，再说明我的想法。', { exact: true })).toBeVisible();
      await review.getByRole('checkbox', { name: '已核对当前意图、事实与承诺，并确认上述适用范围', exact: true }).check();
      await review.getByRole('checkbox', { name: '确认新建方法且无替代关系', exact: true }).check();
      await review.getByRole('button', { name: '批准并发布', exact: true }).click();
      await expect(review.getByRole('heading', { name: '已发布 careful-response · 版本 1', exact: true })).toBeVisible();
      await fixture.command('observations');

      await manager.getByRole('button', { name: '查看已发布版本', exact: true }).click();
      await manager.getByRole('button', { name: '管理方法停用', exact: true }).click();
      const feedback = manager.getByRole('region', { name: '方法与Skill反馈', exact: true });
      await feedback.getByRole('combobox', { name: '明确停用目标', exact: true })
        .selectOption({ label: 'careful-response · 方法「合成排除方法甲」' });
      await feedback.getByRole('combobox', { name: '停用范围', exact: true }).selectOption('contact_scene');
      await feedback.getByRole('textbox', { name: '反馈精确场景', exact: true }).fill('核对安排');
      await feedback.getByRole('button', { name: '按此范围停用', exact: true }).click();
      await expect(feedback.getByRole('heading', { name: 'careful-response · 方法已停用', exact: true })).toBeVisible();
      const filtered = await fixture.command('feedback_reply');
      expect(filtered.used).toBe(true);
      expect(filtered.excluded_text_present).toBe(false);
      expect((filtered.view as { method_ids: string[] }).method_ids).toHaveLength(1);
      for (const extra of [{ scene: '其他场景' }, { other: true }]) {
        expect((await fixture.command('feedback_reply', extra)).excluded_text_present).toBe(true);
      }

      await host.close();
      expect((await fixture.command('restart_backend')).state).toBe('restarted');
      host = new PageHost(await browser.newContext(), origin, userData);
      await host.backend.connect();
      manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成演进甲联系人', exact: true }).click();
      expect((await fixture.command('feedback_reply')).excluded_text_present).toBe(false);
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${prepared.source_id}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      let queuedTask: string | undefined;
      try { await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible(); }
      catch (error) {
        const state = await manager.evaluate(() => window.notalone.sources.getState());
        const task = state.sources.find(item => item.sourceId === prepared.source_id)?.task;
        if (state.phase !== 'ready' || state.error || task?.status !== 'queued') throw error;
        queuedTask = task.taskId;
        await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      }
      if (queuedTask) expect((await manager.evaluate(() => window.notalone.sources.getState()))
        .sources.find(item => item.sourceId === prepared.source_id)!.task!.taskId).toBe(queuedTask);
      expect((await fixture.command('verify_deleted')).verified).toBe(true);
      await selectMemoryCategory(manager, '本人概览');
      await expect(manager.getByRole('region', { name: '本人事实与偏好概览', exact: true })
        .getByText(prepared.owner_text, { exact: true })).toHaveCount(0);
      await manager.getByRole('button', { name: 'Skill 待审核', exact: true }).click();
      await manager.getByRole('button', { name: '查看已发布版本', exact: true }).click();
      const history = manager.getByRole('region', { name: 'Skill版本历史', exact: true });
      await expect(history.getByRole('article', { name: '版本历史 careful-response', exact: true })).toHaveCount(0);
      await expect(history).toContainText('evolution-independent');
    } finally { await host.close(); }
  }), released, path.resolve('tests/fixtures/memory-skill-evolution-page.py'), path.resolve('../backend'),
    'database-ownership.json', 35_000);
  process.stdout.write('page_test_scenario_passed: shared-source-overviews-review-publish-feedback-restart-delete\n');
}
