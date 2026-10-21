import { seedImportContact } from './file-import-navigation';
import { selectContact, expectContactOption } from './contact-picker-actions.mjs';
import { openAssistantHistory, expandSavedDiscussion } from './assistant-history-actions';
import { expect } from '@playwright/test';
import { test, selectMenu } from './app-fixture';
import { isolatedAppEnvironment } from './app-fixture';
import { launchApp } from './app-test-gate';
import { access, appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';

async function preflight(executable: string) {
  const python = path.resolve(path.dirname(executable), '../Resources/notalone-runtime/python/bin/python3.12');
  const result = await promisify(execFile)(python, ['-I', '-B', '-c', 'import sitecustomize; sitecustomize.assert_sdk_canary()'],
    { env: { HOME: tmpdir(), NOTALONE_DISABLE_DOTENV: '1' } });
  expect(result.stdout.trim()).toBe('synthetic_sdk_canary_passed');
}

test.beforeAll(async () => {
  if (process.env.NOTALONE_TEST_MANUAL_MODEL_FIXTURE === '1') await preflight(process.env.NOTALONE_TEST_APP_EXECUTABLE!);
});

test.use({ appWorkingDirectory: '/' });

// 只保留合成传输的分类计数；失败时不保留runtime.env或数据库。
test.afterEach(async ({ runningApp: { userData } }, info) => {
  const audit = await readFile(path.join(userData, 'synthetic-model-audit.json')).catch(() => Buffer.from('{"model_transport":"not_reached"}'));
  const file = info.outputPath('synthetic-model-audit.json');
  await writeFile(file, audit);
  await info.attach('synthetic-model-audit', { path: file, contentType: 'application/json' });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('空目录首启不提供独立创建入口，预置联系人仍可手动输入', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(90_000);
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
  if (process.env.NOTALONE_TEST_MANUAL_MODEL_FIXTURE === '1') expect(JSON.parse(await readFile(path.join(userData, 'synthetic-model-audit.json'), 'utf8')).network_guard).toBe(true);
  await manager.getByLabel('本人展示名称', { exact: true }).fill('合成手动使用者');
  await manager.getByRole('button', { name: '初始化本人', exact: true }).click();
  await expect(manager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeAttached({ timeout: 30_000 });
  await expect(manager.getByRole('heading', { name: '还没有联系人', exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: '创建联系人', exact: true })).toHaveCount(0);
  await expect(manager.getByLabel('联系人展示名称', { exact: true })).toHaveCount(0);
  await seedImportContact(manager, '合成联系人甲', { infoPath: path.join(userData, 'managed/backend.info') });
  await expectContactOption(manager.getByRole('combobox', { name: '本次联系人', exact: true }), '合成联系人甲');
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveAttribute('data-contact-id', '');
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toContainText('合成联系人甲');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
  const helper = await opened;
  await expect(helper).toHaveURL(/#helper$/);
  await expect(helper.getByRole('button', { name: '回应消息', exact: true })).toBeVisible({ timeout: 1000 });
  const databasePid = Number((await readFile(path.join(userData, 'managed/postgres/postmaster.pid'), 'utf8')).split('\n')[0]);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await expect.poll(() => alive(databasePid)).toBe(false);
});

test('公开手动输入完成模型设置、依据和编辑，切换隔离、故障重试、搬动重开与退出', async ({ runningApp: { app, appProcess, userData } }) => {
  test.skip(process.env.NOTALONE_TEST_MANUAL_MODEL_FIXTURE !== '1', '本场须使用只替换模型HTTP传输的隔离合成包');
  test.setTimeout(240_000);
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
  if (process.env.NOTALONE_TEST_MANUAL_MODEL_FIXTURE === '1') expect(JSON.parse(await readFile(path.join(userData, 'synthetic-model-audit.json'), 'utf8')).network_guard).toBe(true);
  await manager.getByLabel('本人展示名称', { exact: true }).fill('合成手动使用者');
  await manager.getByRole('button', { name: '初始化本人', exact: true }).click();
  await expect(manager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeAttached({ timeout: 30_000 });
  const opening = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opening;
  await expect(helper).toHaveURL(/#helper$/);
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
  await expect(helper.getByLabel('草稿', { exact: true })).toBeDisabled();
  await manager.bringToFront();
  async function create(name: string) {
    await seedImportContact(manager, name, { infoPath: path.join(userData, 'managed/backend.info') });
  }
  await create('合成联系人甲');
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await manager.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
  await helper.getByLabel('草稿', { exact: true }).fill('合成甲，我会晚一点回复。');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByText('回复服务暂不可用，请在管理后台补齐本人身份与模型设置，再重试。', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '打开本人和模型设置', exact: true }).click();
  await manager.getByLabel('DeepSeek API Key', { exact: true }).fill('synthetic-manual-package-not-a-real-key');
  await manager.getByRole('button', { name: '保存 DeepSeek 密钥', exact: true }).click();
  await expect(manager.getByText('DeepSeek · 已配置', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveAttribute('data-contact-id', '');
  await create('合成联系人乙');
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  await expect(manager.getByRole('heading', { name: '微信自动接入尚未提供', exact: true })).toBeVisible();
  await expect(manager.getByText('正常退出并重新打开 App，再配置已安装的只读 CLI。', { exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: '选择联系人并手动输入', exact: true }).click();
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await manager.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('button', { name: '粘贴文字', exact: true }).click();
  await helper.getByLabel('当前聊天文字', { exact: true }).fill('合成甲：今晚要一起去吗？');
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
  await helper.getByLabel('粘贴文字的表达方向', { exact: true }).fill('今天不去，简短婉拒，不增加承诺');
  await helper.getByRole('button', { name: '生成候选', exact: true }).dblclick();
  const candidate = helper.getByLabel('候选1编辑文本', { exact: true });
  await expect(candidate).toHaveValue('合成甲，我知道了，我们晚点再确认。', { timeout: 30_000 });
  const audit = JSON.parse(await readFile(path.join(userData, 'synthetic-model-audit.json'), 'utf8'));
  expect(audit).toMatchObject({ calls: 1, network: 'mock-only', last_mode: 'reply_to_pasted_text', last_evidence_kind: 'user_current_chat' });
  await candidate.fill('合成甲，改成我自己的说法。');
  await helper.getByRole('button', { name: '本次参考', exact: true }).click();
  await expect(helper.getByRole('region', { name: '本次参考内容', exact: true }).getByText('你补充的聊天（未经渠道核验）', { exact: true })).toBeVisible();
  await manager.bringToFront();
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人乙' });
  await manager.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
  await expect(helper.getByLabel('草稿', { exact: true })).toHaveValue('');
  await expect(helper.getByLabel('候选1编辑文本', { exact: true })).toHaveCount(0);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('button', { name: '粘贴文字', exact: true }).click();
  await helper.getByLabel('当前聊天文字', { exact: true }).fill('合成乙：明天再确认时间。');
  await helper.getByLabel('粘贴文字的表达方向', { exact: true }).fill('表示收到，暂不承诺时间');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(candidate).toHaveValue('合成乙，我知道了，我们晚点再确认。', { timeout: 30_000 });
  await manager.bringToFront();
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await manager.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
  await expect(candidate).toHaveValue('合成甲，改成我自己的说法。');
  // 切换后编辑输入按既有合同清空；已生成候选仍保留原输入快照。
  await expect(helper.getByLabel('当前聊天文字', { exact: true })).toHaveValue('');
  await helper.getByText('这组候选的生成输入 · 合成联系人甲', { exact: true }).click();
  await expect(helper.getByText('本次粘贴的对方文字：合成甲：今晚要一起去吗？', { exact: true })).toBeVisible();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toBeVisible();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  await helper.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(helper.getByText('当前助手会话已删除。', { exact: true })).toBeVisible();
  await expect(candidate).toHaveCount(0);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('button', { name: '粘贴文字', exact: true }).click();
  await expect(helper.getByLabel('当前聊天文字', { exact: true })).toHaveValue('');
  await helper.getByLabel('当前聊天文字', { exact: true }).fill('合成模型故障：请稍后再联系。');
  await helper.getByLabel('粘贴文字的表达方向', { exact: true }).fill('表示收到');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('button', { name: '重试同一次生成', exact: true })).toBeVisible({ timeout: 30_000 });
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(candidate).toHaveValue('合成甲，我知道了，我们晚点再确认。', { timeout: 30_000 });
  const firstAudit = await readFile(path.join(userData, 'synthetic-model-audit.json'), 'utf8');
  expect(JSON.parse(firstAudit)).toMatchObject({ calls: 6, failures: 3, network_guard: true });
  await writeFile(test.info().outputPath('first-runtime-model-audit.json'), firstAudit);
  const databasePid = Number((await readFile(path.join(userData, 'managed/postgres/postmaster.pid'), 'utf8')).split('\n')[0]);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
  await expect.poll(() => alive(databasePid)).toBe(false);
  expect(await access(path.join(userData, 'managed/backend.info')).then(() => true, () => false)).toBe(false);
  // 仅安排本轮合成旧模型设置，不读取或复用任何旧密钥；联系人仍全部来自公开UI。
  await appendFile(path.join(userData, 'managed/runtime.env'), '\nNOTALONE_DEEPSEEK_MODEL=deepseek-chat\nNOTALONE_DEEPSEEK_BASE_URL=https://api.deepseek.com\n');
  const originalApp = path.dirname(path.dirname(path.dirname(process.env.NOTALONE_TEST_APP_EXECUTABLE!)));
  const movedDirectory = await mkdtemp(path.join(tmpdir(), 'notalone-manual-moved-'));
  const movedApp = path.join(movedDirectory, 'NotAlone.app');
  let reopened: Awaited<ReturnType<typeof launchApp>> | undefined;
  let reopenedProcess: ChildProcess | undefined;
  try {
    await rename(originalApp, movedApp);
    await preflight(path.join(movedApp, 'Contents/MacOS/NotAlone'));
    reopened = await launchApp({ executablePath: path.join(movedApp, 'Contents/MacOS/NotAlone'), cwd: '/',
      args: [`--user-data-dir=${userData}`], env: isolatedAppEnvironment(userData) });
    reopenedProcess = reopened.process();
    await writeFile(test.info().outputPath('reopened-app-owned.json'), JSON.stringify({ pid: reopenedProcess.pid, userData, executable: path.join(movedApp, 'Contents/MacOS/NotAlone') }));
    const next = await reopened.firstWindow();
    await expect(next.getByText('已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(next.getByText('DeepSeek · 已配置', { exact: true })).toBeVisible();
    await expect(next.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveAttribute('data-contact-id', '');
    await expectContactOption(next.getByRole('combobox', { name: '本次联系人', exact: true }), '合成联系人甲');
    await expectContactOption(next.getByRole('combobox', { name: '本次联系人', exact: true }), '合成联系人乙');
    await expect(next.getByRole('button', { name: '改用官方 DeepSeek 默认配置', exact: true })).toBeVisible();
    await selectContact(next.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    const helperOpening = reopened.waitForEvent('window');
    await next.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
    const nextHelper = await helperOpening;
    await expect(nextHelper).toHaveURL(/#helper$/);
    await nextHelper.getByLabel('草稿', { exact: true }).fill('合成甲恢复后的草稿。');
    await nextHelper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(nextHelper.getByText('当前模型或接收地址的完整输入预算暂不可核验，本次生成已停止。请在本人和模型设置中核对原配置；如需改用官方默认配置，须明确确认接收方并重新输入对应密钥。已填写内容和讨论仍会保留。', { exact: true })).toBeVisible();
    await nextHelper.getByRole('button', { name: '打开本人和模型设置', exact: true }).click();
    await next.getByRole('button', { name: '改用官方 DeepSeek 默认配置', exact: true }).click();
    await expect(next.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
    await next.getByLabel('DeepSeek API Key', { exact: true }).fill('synthetic-manual-official-recovery-not-a-real-key');
    await expect(next.getByRole('button', { name: '保存官方模型与新密钥', exact: true })).toBeDisabled();
    await next.getByLabel('我确认改用上述官方接收方，并为它重新输入密钥', { exact: true }).check();
    await next.getByRole('button', { name: '保存官方模型与新密钥', exact: true }).click();
    await expect(next.getByText('模型接收方：DeepSeek 官方（https://api.deepseek.com），模型 deepseek-flash。', { exact: true })).toBeAttached({ timeout: 30_000 });
    await next.locator('summary', { hasText: '数据存储与隐私' }).click();
    await expect(next.getByText('模型接收方：DeepSeek 官方（https://api.deepseek.com），模型 deepseek-flash。', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(next.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveAttribute('data-contact-id', '');
    await selectContact(next.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await next.getByRole('button', { name: '手动输入本次聊天', exact: true }).click();
    await nextHelper.getByLabel('草稿', { exact: true }).fill('合成甲恢复后的草稿。');
    await nextHelper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(nextHelper.getByLabel('候选1编辑文本', { exact: true })).toHaveValue('合成甲，我知道了，我们晚点再确认。', { timeout: 30_000 });
    const finalDatabasePid = Number((await readFile(path.join(userData, 'managed/postgres/postmaster.pid'), 'utf8')).split('\n')[0]);
    await selectMenu(reopened, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => reopenedProcess!.exitCode, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => alive(finalDatabasePid)).toBe(false);
    expect(await access(path.join(userData, 'managed/backend.info')).then(() => true, () => false)).toBe(false);
  } finally {
    if (reopened && reopenedProcess?.exitCode === null) await reopened.close().catch(() => {});
    if (await access(movedApp).then(() => true, () => false)) await rename(movedApp, originalApp);
    await rm(movedDirectory, { recursive: true, force: true });
  }
});
