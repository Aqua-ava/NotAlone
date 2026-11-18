import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium, mountBundle } from './helpers/browser.mjs';

// 用户可感知动作失败不得静默：以下按真实组件的失败行为断言可见错误出口。
// Skill 页重新读取与候选面板「同步设置暂未打开」分别由 skill-learning/sqlite-library-view、
// sqlite-reply-candidates 的无头用例覆盖。
async function mount(t, contents) {
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    platform: 'browser', format: 'iife', write: false, jsx: 'automatic', loader: { '.css': 'empty' } });
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await mountBundle(page, bundle);
  return page;
}

test('连接状态页重试失败渲染 alert，下一次尝试先清除旧错误', async t => {
  const page = await mount(t, `
    import { createRoot } from 'react-dom/client';
    import { BackendConnectionNote } from './src/renderer/backend-status';
    window.fail = { retry: true, quit: true };
    window.notalone = { backend: {
      retryConnection: () => window.fail.retry ? Promise.reject(new Error('synthetic')) : new Promise(() => {}),
      quit: () => window.fail.quit ? Promise.reject(new Error('synthetic')) : new Promise(() => {}),
    } };
    const state = { phase: 'shutdown-failed', reused: false, revision: 1, canRetryConnection: true, canRetryShutdown: true, canSaveStartupPaths: false };
    createRoot(document.getElementById('root')).render(<BackendConnectionNote state={state} />);
  `);
  const note = page.getByRole('region', { name: '连接状态' });
  await note.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(note.getByRole('alert').filter({ hasText: '重试连接未成功，请稍后再试。' })).toHaveCount(1);
  await note.getByRole('button', { name: '重试停读并退出', exact: true }).click();
  await expect(note.getByRole('alert').filter({ hasText: '重试停读尚未获确认，请稍后再试。' })).toHaveCount(1);
  assert.equal(await note.getByText('重试连接未成功，请稍后再试。').count(), 0, '新一次失败只保留最新错误');
  // 下一次尝试开始即清除旧错误；结果未返回前不得继续显示上一次失败。
  await page.evaluate(() => { window.fail.retry = false; });
  await note.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(note.getByText('重试停读尚未获确认，请稍后再试。')).toHaveCount(0);
});

test('表达面板首帧读取失败与操作失败都有 alert，重试读取成功后清除', async t => {
  const page = await mount(t, `
    import { createRoot } from 'react-dom/client';
    import { ReplyCandidates, useReplySession } from './src/renderer/RewritePanel';
    window.fail = { read: true };
    window.notalone = { replies: {
      getState: () => window.fail.read ? Promise.reject(new Error('synthetic'))
        : Promise.resolve({ revision: 1, scopeRevision: 0, contactId: null, generationBlock: 'foreground-confirmation-required' }),
      onStateChanged: () => () => {},
      readSavedSession: () => Promise.reject(new Error('synthetic')),
    } };
    function View() {
      const replies = useReplySession();
      return <><button onClick={() => void replies.readSavedSession()}>触发会话操作</button><ReplyCandidates replies={replies} /></>;
    }
    createRoot(document.getElementById('root')).render(<View />);
  `);
  await expect(page.getByRole('alert')).toHaveText(/状态读取失败，请重试。/);
  await page.getByRole('button', { name: '触发会话操作', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(/本次表达操作暂时不可用，请重新确认联系人。/);
  await page.evaluate(() => { window.fail.read = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
