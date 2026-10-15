import { expect, type Browser } from '@playwright/test';
import { visualAcceptanceHtml } from '../visual-acceptance-window';
import { renderVisualAcceptance } from '../visual-acceptance-html.mjs';
import { projectVisualAcceptance } from '../visual-acceptance-view.mjs';
import { initialForegroundState, type ForegroundState } from '../../src/shared/foreground-bridge';

// 点击真实验收窗同一HTML，不创建Electron或读取微信。
export async function foregroundVisualPreview(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 500, height: 900 } });
  try {
    const page = await context.newPage();
    await page.setContent(visualAcceptanceHtml);
    await page.getByLabel('本次只验收哪一位微信会话？', { exact: true }).fill('仅用于页面的合成会话');
    await page.getByLabel('我确认本次只识别填写的会话及群聊暂停状态', { exact: true }).check();
    await page.getByRole('button', { name: '开始可视验收', exact: true }).click();
    await expect(page.locator('#live')).toBeVisible();
    const finish = page.getByRole('button', { name: '结束验收并退出', exact: true });
    await expect(finish).toBeDisabled();
    const counts = { matches: 0, mismatches: 0, unverified: 0, monitorFailed: false,
      stateUpdates: 1, matchedSamples: 0, helperPausedSamples: 0, otherPausedSamples: 0, failures: {} };
    const update = (patch: Partial<ForegroundState>) => page.evaluate(renderVisualAcceptance, {
      view: projectVisualAcceptance({ foreground: { ...initialForegroundState, ...patch },
        selectedContactId: 'contact-a', expectedContactId: 'contact-a' }),
      coordination: { runId: 'synthetic-run', stage: 'finish', state: 'waiting-trigger' }, counts,
    });
    await update({ phase: 'unavailable', reason: 'session_name_confidence_low', wechatInFront: false });
    await expect(page.locator('#failure')).toHaveText('失败环节：名称识别 · 名称识别置信度不足');
    await page.getByRole('button', { name: '我看到微信在前台', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已收到');
    await expect(page.getByRole('status')).toContainText('未验证');
    await expect(page.getByRole('button', { name: '本步检查', exact: true })).toHaveCount(0);
    const confirmed: Partial<ForegroundState> = { phase: 'confirmed', observedAt: new Date().toISOString(),
      recognizedName: '仅本机展示的合成会话', recognitionConfidence: 0.96, generationBlock: null,
      wechatInFront: true, probeAvailable: true, confirmation: 'verified-binding', confirmedContactId: 'contact-a' };
    await update(confirmed);
    await expect(page.locator('#headline')).toContainText('微信在前台');
    await expect(page.locator('#detail')).toHaveText('已通过正式绑定匹配测试联系人');
    await expect(page.locator('#failure')).toBeEmpty();
    await expect(page.getByRole('region', { name: '本机实时识别', exact: true })).toContainText('仅本机展示的合成会话');
    await expect(page.getByRole('region', { name: '本机实时识别', exact: true })).toContainText('96%');
    await page.getByRole('button', { name: '切回后草稿保留：符合', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('人工反馈');
    const feedback = await update(confirmed);
    expect(feedback).toContainEqual(expect.objectContaining({ type: 'checklist', checkId: 'draft-restore', outcome: 'matches' }));
    await page.screenshot({ path: 'artifacts/foreground-manual-panel-preview.png', fullPage: true });
    await update({ ...confirmed, phase: 'paused', unsupportedConversation: true,
      reason: 'group_chat_suspected', recognizedName: '不应展示的合成群 (9)', generationBlock: 'foreground-confirmation-required' });
    await expect(page.locator('#headline')).toContainText('群聊');
    await expect(page.getByRole('region', { name: '本机实时识别', exact: true })).not.toContainText('不应展示');
    await page.getByRole('button', { name: '我看到微信在前台', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('一致');
    await update({ ...confirmed, suspendedByHelperFocus: true });
    await expect(page.locator('#headline')).toContainText('助手获焦，定位暂停');
    await update({ phase: 'paused', reason: 'wechat_not_in_front', observedAt: new Date().toISOString(),
      wechatInFront: false, probeAvailable: true });
    await expect(page.locator('#detail')).toContainText('定位暂停');
    await expect(page.locator('#failure')).toBeEmpty();
    await page.getByRole('button', { name: '打开正式助手', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('正在打开正式助手');
    await update({ phase: 'unavailable', reason: 'PRIVATE_RAW_ERROR' });
    await expect(page.locator('#failure')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText('PRIVATE');
    await finish.click();
    await expect(page.getByRole('status')).toContainText('已收到结束操作');
    const events = await update({ phase: 'unavailable' });
    expect(events.map(event => event.type)).toContain('finish');
    await expect(finish).toBeDisabled();
  } finally { await context.close(); }
}
