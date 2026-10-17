import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

export async function skillLifecycle(browser: Browser, origin: string) {
  const released = ownResource();
  await withRewriteFixture('notalone-lifecycle-pages-', async fixture => withControllerEnvironment(fixture, async userData => {
    let host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      let manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill 待审核', exact: true }).click();
      const panel = manager.getByRole('region', { name: 'Skill待审核', exact: true });
      await panel.getByRole('button', { name: '开启此联系人的经验整理', exact: true }).click();
      await expect(panel.getByRole('button', { name: '关闭经验整理', exact: true })).toBeEnabled();
      const prepared = await fixture.command('prepare_merge');
      await expect(panel.getByRole('article', { name: '待审核 careful-response', exact: true })).toBeVisible({ timeout: 20_000 });
      await panel.getByRole('button', { name: '打开对照审核', exact: true }).click();
      const review = manager.getByRole('region', { name: 'Skill对照审核', exact: true });
      const changes = review.getByRole('region', { name: '版本变化与替代范围', exact: true });
      await expect(changes.getByRole('heading', { name: 'careful-response · 原版本 1', exact: true })).toBeVisible();
      await expect(changes.getByRole('heading', { name: 'calm-response · 原版本 1', exact: true })).toBeVisible();
      await changes.getByText('查看原版本正文', { exact: true }).first().click();
      await expect(changes.getByText(/合成旧方法：先问清楚再回应/).first()).toBeVisible();
      await review.getByRole('textbox', { name: '对照来话', exact: true }).fill('合成版本合并情境');
      await review.getByRole('textbox', { name: '当前意图与约束', exact: true }).fill('先说明边界，再核对含义');
      await review.getByRole('textbox', { name: '精确场景', exact: true }).fill('核对安排');
      await review.getByRole('combobox', { name: '适用范围', exact: true }).selectOption('owner');
      await review.getByRole('button', { name: '相同输入生成对照', exact: true }).click();
      await expect(review.getByRole('region', { name: '冻结输入对照', exact: true })).toBeVisible();
      await review.getByRole('checkbox', { name: '已核对当前意图、事实与承诺，并确认上述适用范围', exact: true }).check();
      await review.getByRole('checkbox', { name: '确认上述替代版本与方法延续映射', exact: true }).check();
      await review.getByRole('button', { name: '批准并发布', exact: true }).click();
      await expect(review.getByRole('heading', { name: '已发布 careful-response · 版本 2', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '查看已发布版本', exact: true }).click();
      let histories = manager.getByRole('region', { name: 'Skill版本历史', exact: true });
      let primary = histories.getByRole('article', { name: '版本历史 careful-response', exact: true });
      await expect(primary.getByRole('heading', { name: '版本 2 · 当前版本', exact: true })).toBeVisible();
      await primary.getByText('查看版本 1 的正文与映射', { exact: true }).click();
      await expect(primary.getByText(/合成旧方法：先问清楚再回应/)).toBeVisible();
      await primary.getByRole('button', { name: '回滚到版本 1', exact: true }).click();
      await expect(primary.getByRole('heading', { name: '版本 1 · 当前版本', exact: true })).toBeVisible();
      await expect(histories.getByRole('article', { name: '版本历史 calm-response', exact: true })).toContainText('已停用');
      await host.close();
      await fixture.command('restart_backend');
      host = new PageHost(await browser.newContext(), origin, userData);
      await host.backend.connect(); manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill 待审核', exact: true }).click();
      await manager.getByRole('button', { name: '查看已发布版本', exact: true }).click();
      histories = manager.getByRole('region', { name: 'Skill版本历史', exact: true });
      primary = histories.getByRole('article', { name: '版本历史 careful-response', exact: true });
      await expect(primary.getByRole('heading', { name: '版本 1 · 当前版本', exact: true })).toBeVisible();
      await manager.getByRole('button', { name: '关系资料', exact: true }).click();
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${prepared.source_id}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      try { await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible(); }
      catch (error) {
        const state = await manager.evaluate(() => window.notalone.sources.getState());
        if (state.phase !== 'ready' || state.error || state.sources.find(item => item.sourceId === prepared.source_id)?.task?.status !== 'queued') throw error;
        await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      }
      await manager.getByRole('button', { name: 'Skill 待审核', exact: true }).click();
      await manager.getByRole('button', { name: '查看已发布版本', exact: true }).click();
      await expect(primary.getByRole('heading', { name: '版本 1 · 当前版本', exact: true })).toBeVisible();
      await expect(primary.getByRole('heading', { name: /^版本 2/ })).toHaveCount(0);
      const observations = await fixture.command('observations');
      expect(observations.model_calls).toBe(1);
      expect(observations.reply_calls).toBe(4);
    } finally { await host.close(); }
  }), released, path.resolve('tests/fixtures/skill-learning-page.py'), path.resolve('../backend'));
  process.stdout.write('page_test_scenario_passed: skill-lifecycle-merge-diff-mapping-history-rollback-restart-source-erasure\n');
}
