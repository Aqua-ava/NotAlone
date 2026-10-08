import { expect } from '@playwright/test';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from './setup-fixture';

test('空白真实后端显示首启本人配置，并等待用户明确初始化', async ({ runningApp: { app }, setup }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('DeepSeek 尚未配置', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '本人展示名称' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '初始化本人' })).toBeEnabled();
  expect(await setup.request('/api/setup/status')).toEqual({ status: 200, data: {
    initialized: false, owner_configured: false, credentials_configured: false, runtime_owner_configured: false,
  } });
});

test.describe('既有配置', () => {
  test.use({ setupSeed: 'configured' });
  test('真实既有配置直接复用，不再显示初始化或回显密钥', async ({ runningApp: { app }, setup }) => {
    const before = await readFile(setup.envPath);
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '初始化本人' })).toHaveCount(0);
    await expect(panel.getByLabel('DeepSeek API Key')).toHaveCount(0);
    expect((await readFile(setup.envPath)).equals(before)).toBe(true);
    expect((await stat(setup.envPath)).mode & 0o777).toBe(0o600);
    expect(await panel.textContent()).not.toContain('sk-synthetic-existing-key');
    expect(await setup.request('/api/setup/status')).toEqual({ status: 200, data: {
      initialized: true, owner_configured: true, credentials_configured: true, runtime_owner_configured: true,
    } });
  });

  test('密钥保存失败保持真实已配置状态，输入清空且安全错误不回显', async ({ runningApp: { app }, setup }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
    await rename(setup.envPath, path.join(setup.directory, 'saved-synthetic.env'));
    await mkdir(setup.envPath);
    await panel.getByRole('button', { name: '更新 DeepSeek 密钥' }).click();
    await panel.getByLabel('DeepSeek API Key').fill('sk-synthetic-failed-key');
    await panel.getByRole('button', { name: '保存 DeepSeek 密钥' }).click();
    await expect(panel.getByText('DeepSeek 密钥未能保存，请重新输入后重试。', { exact: true })).toBeVisible();
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '更新 DeepSeek 密钥' }).click();
    await expect(panel.getByLabel('DeepSeek API Key')).toHaveValue('');
    expect(await panel.textContent()).not.toContain('sk-synthetic-failed-key');
    expect(await setup.request('/api/settings/credentials')).toEqual({ status: 200, data: { provider: 'deepseek', configured: true } });
  });

  test('具名配置桥接拒绝非法参数和小窗写入，renderer 没有通用请求能力', async ({ runningApp: { app }, setup }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    await expect(manager.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
    const rejection = await manager.evaluate(async () => {
      const bridge = window.notalone.setup as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const rejected = async (operation: () => Promise<unknown>) => { try { await operation(); return false; } catch { return true; } };
      return Promise.all([
        rejected(() => bridge.saveDeepSeekKey('sk-invalid\nNOTALONE_OWNER_ID=bad')),
        rejected(() => bridge.saveDeepSeekKey('sk-extra', 'extra')),
        rejected(() => bridge.initializeOwner({ display_name: '绕过' })),
      ]);
    });
    expect(rejection).toEqual([true, true, true]);
    expect(await manager.evaluate(() => Object.keys(window.notalone))).not.toContain('requestJson');
    const opened = app.waitForEvent('window');
    await manager.getByRole('button', { name: '打开输入小窗' }).click();
    const helper = await opened;
    const rejected = await helper.evaluate(async () => {
      try { await window.notalone.setup.saveDeepSeekKey('sk-synthetic-helper-key'); return false; }
      catch { return true; }
    });
    expect(rejected).toBe(true);
    expect(await setup.request('/api/settings/credentials')).toEqual({ status: 200, data: { provider: 'deepseek', configured: true } });
  });
});

test.describe('未绑定运行身份', () => {
  test.use({ setupSeed: 'unbound' });
  test('全库已有本人资料不自动认作当前身份，阻塞初始化并提示检查配置', async ({ runningApp: { app }, setup }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('检测到既有本人资料，但本次运行尚未绑定本人身份。请检查受控配置后重新连接。', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole('button', { name: '初始化本人' })).toHaveCount(0);
    await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toHaveCount(0);
    expect(await setup.request('/api/setup/status')).toEqual({ status: 200, data: { initialized: true, owner_configured: true, credentials_configured: false, runtime_owner_configured: false } });
    expect(await setup.request('/api/contacts')).toEqual({ status: 503, data: { error: 'owner_uninitialized' } });
    await manager.evaluate(() => window.notalone.setup.initializeOwner('不可自动恢复的用户'));
    expect((await setup.request('/api/contacts')).status).toBe(503);
    expect(await stat(setup.envPath).then(() => true, () => false)).toBe(false);
  });
});

test.describe('复用运行时', () => {
  test.use({ setupSeed: 'reused' });
  test('更新密钥正常关闭经验证的复用服务，再启动唯一新运行时', async ({ runningApp: { app }, setup }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(manager.getByText('已验证既有运行时。', { exact: true })).toBeVisible();
    const previous = await readFile(setup.infoPath);
    await panel.getByRole('button', { name: '更新 DeepSeek 密钥' }).click();
    await panel.getByLabel('DeepSeek API Key').fill('sk-synthetic-reused-update');
    await panel.getByRole('button', { name: '保存 DeepSeek 密钥' }).click();
    // 先确认新实例，避免把点击前仍可见的已配置状态误当作重启完成。
    await expect(manager.getByText('已启动并验证本机运行时。', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => setup.reusedBackend?.exitCode).toBe(0);
    expect((await readFile(setup.infoPath)).equals(previous)).toBe(false);
    expect(await setup.request('/api/contacts')).toEqual({ status: 200, data: { contacts: [] } });
  });
});

test.describe('不存在的运行本人 UUID', () => {
  test.use({ setupSeed: 'wrong-owner' });
  test('库中其他 owner 存在且 contacts200为空时，仍拒绝本次身份就绪和自动恢复', async ({ runningApp: { app }, setup }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('检测到既有本人资料，但本次运行尚未绑定本人身份。请检查受控配置后重新连接。', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await setup.request('/api/contacts')).toEqual({ status: 200, data: { contacts: [] } });
    expect(await setup.request('/api/setup/status')).toEqual({ status: 200, data: {
      initialized: true, owner_configured: true, credentials_configured: false, runtime_owner_configured: false,
    } });
    await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '初始化本人' })).toHaveCount(0);
    const before = await readFile(setup.envPath);
    await manager.evaluate(() => window.notalone.setup.initializeOwner('不可恢复他人身份'));
    expect((await readFile(setup.envPath)).equals(before)).toBe(true);
  });
});

test('已保存的本人配置遇到真实启动失败时不报就绪，恢复后明确重试加载', async ({ runningApp: { app }, setup }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  await writeFile(path.join(setup.directory, 'restart-unavailable'), 'synthetic unavailable');
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('重启恢复合成用户');
  await panel.getByRole('button', { name: '初始化本人' }).click();
  await expect(panel.getByText('配置已保存，但后端重启未获确认。请重试加载配置。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toHaveCount(0);
  await rm(path.join(setup.directory, 'restart-unavailable'));
  await panel.getByRole('button', { name: '重试加载配置', exact: true }).click();
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect((await setup.request('/api/setup/status')).data.runtime_owner_configured).toBe(true);
  expect(await setup.request('/api/contacts')).toEqual({ status: 200, data: { contacts: [] } });
});

test('用户明确初始化本人后，认证停读并重启真实后端使本人范围就绪', async ({ runningApp: { app, appProcess }, setup }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('首启合成用户');
  await panel.getByRole('button', { name: '初始化本人' }).click();
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('button', { name: '初始化本人' })).toHaveCount(0);
  expect(await setup.request('/api/contacts')).toEqual({ status: 200, data: { contacts: [] } });
  expect((await setup.request('/api/setup/status')).data.runtime_owner_configured).toBe(true);
  expect(appProcess.exitCode).toBeNull();
});

test('DeepSeek 密钥只受控提交，提交后清空且仅展示已配置和真实数据处理说明', async ({ runningApp: { app }, setup }) => {
  const manager = await app.firstWindow();
  const logs: string[] = [];
  manager.on('console', (message) => logs.push(message.text()));
  app.process().stdout?.on('data', (data: Buffer) => logs.push(data.toString()));
  app.process().stderr?.on('data', (data: Buffer) => logs.push(data.toString()));
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('密钥合成用户');
  await panel.getByRole('button', { name: '初始化本人' }).click();
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
  const key = panel.getByLabel('DeepSeek API Key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('sk-synthetic-first-run-key');
  await panel.getByRole('button', { name: '保存 DeepSeek 密钥', exact: true }).click();
  await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(key).toHaveCount(0);
  expect(await setup.request('/api/settings/credentials')).toEqual({ status: 200, data: { provider: 'deepseek', configured: true } });
  const state = await manager.evaluate(() => window.notalone.setup.getState());
  expect(JSON.stringify(state)).not.toContain('sk-synthetic-first-run-key');
  expect(await panel.textContent()).not.toContain('sk-synthetic-first-run-key');
  expect(logs.join('\n')).not.toContain('sk-synthetic-first-run-key');
  await panel.getByRole('button', { name: '更新 DeepSeek 密钥', exact: true }).click();
  await expect(key).toHaveValue('');
  await key.fill('sk-synthetic-cancelled-key');
  await panel.getByRole('button', { name: '清空输入', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(panel.getByText(/长期保存在本机 PostgreSQL/)).toBeVisible();
  await expect(panel.getByText(/未提供静态加密/)).toBeVisible();
  await expect(panel.getByText(/当次范围内的必要文字/)).toBeVisible();
  await expect(panel.getByText(/不代表 DeepSeek 的外部副本已删除/)).toBeVisible();
  await manager.screenshot({ path: test.info().outputPath('configured.png') });
});
