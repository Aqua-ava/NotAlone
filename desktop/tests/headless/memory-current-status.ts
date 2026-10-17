import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import { confirmHelperContact } from '../foreground-confirmation-actions';

export async function memoryCurrentStatus(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    const prepared = await rewriteBackend.command('memory_current_status') as Record<string, string>;
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await manager.getByRole('button', { name: '关系资料', exact: true }).click();
    await manager.getByRole('button', { name: '刷新关系资料', exact: true }).click();
    const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
    const card = (text: string) => contact.getByRole('article').filter({ has: manager.getByText(text, { exact: true }) });
    await expect(card('合成旧近况：最近在加班。').getByText('当前核实状态：当前未核实', { exact: true })).toBeVisible();
    await expect(card('合成当期近况：这个月在加班。').getByText('当前核实状态：当前已核实（来源支持当期区间）', { exact: true })).toBeVisible();
    await expect(card('合成历史近况：这个月在加班。').getByText('当前核实状态：历史资料（已过期）', { exact: true })).toBeVisible();
    await expect(card('合成稳定偏好：一直喜欢咖啡。').getByText('当前核实状态：稳定事实或明确偏好', { exact: true })).toBeVisible();
    await expect(card('合成职业近况：对方是建筑师。').getByText('当前核实状态：当前未核实', { exact: true })).toBeVisible();
    await expect(card('合成窄时段：这个月仅晚上在加班。').getByText('当前核实状态：当前未核实', { exact: true })).toBeVisible();
    await expect(manager.getByRole('region', { name: '本人记忆', exact: true })
      .getByText('当前核实状态：稳定事实或明确偏好', { exact: true })).toBeVisible();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('最近在加班忙吗？这个月仅晚上在加班吗？对方是建筑师，现在还成立吗？');
    await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
    await rewriteBackend.plan({ count: 1, text: '最近忙吗？', basis: '旧近况只供历史参考，先询问现在。',
      citation_ids: [prepared.unverified_memory_id, prepared.dynamic_memory_id, prepared.narrow_memory_id] });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('最近忙吗？');
    await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
    const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
    const cited = evidence.getByRole('article').filter({ has: helper.getByText('合成旧近况：最近在加班。', { exact: true }) });
    await expect(cited.getByText('本候选已引用', { exact: true })).toBeVisible();
    await expect(cited.getByText('生成时核实状态：当前未核实', { exact: true })).toBeVisible();
    for (const text of ['合成职业近况：对方是建筑师。', '合成窄时段：这个月仅晚上在加班。']) {
      const item = evidence.getByRole('article').filter({ has: helper.getByText(text, { exact: true }) });
      await expect(item.getByText('本候选已引用', { exact: true })).toBeVisible();
      await expect(item.getByText('生成时核实状态：当前未核实', { exact: true })).toBeVisible();
    }
    await expect(evidence.getByText('合成历史近况：这个月在加班。', { exact: true })).toHaveCount(0);
    const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
      .filter({ hasText: `来源标识：${prepared.source_id}` });
    await source.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card('合成旧近况：最近在加班。')).toHaveCount(0);
    await expect(card('合成当期近况：这个月在加班。')).toHaveCount(0);
    await expect(card('合成历史近况：这个月在加班。')).toHaveCount(0);
    await expect(card('合成职业近况：对方是建筑师。')).toHaveCount(0);
    await expect(card('合成窄时段：这个月仅晚上在加班。')).toHaveCount(0);
    await expect(card('合成稳定偏好：一直喜欢咖啡。')).toBeVisible();
    await expect(evidence).toHaveCount(0);
  });
  process.stdout.write('page_test_scenario_passed: memory-current-status-reply-and-deletion\n');
}
