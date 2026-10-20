import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { selectMenu } from './app-fixture';
import { prepareDatabase, projectDirectory, pythonExecutable, test } from './startup-fixture';

test('空库在原连接内正常初始化，不要求备份或切换数据库，无需终端 PATH', async ({ runningApp: { app, appProcess, userData } }) => {
  const manager = await app.firstWindow();
  const original = await readFile(path.join(userData, 'backend-launch.json'));
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(manager.getByRole('region', { name: '保留资料更新' })).toHaveCount(0);
  await expect(manager.getByRole('button', { name: '备份并完成更新', exact: true })).toHaveCount(0);
  expect((await readFile(path.join(userData, 'backend-launch.json'))).equals(original)).toBe(true);
  expect(await access(path.join(userData, 'updates')).then(() => true, () => false)).toBe(false);
  expect(await access(path.join(userData, 'update-operation.json')).then(() => true, () => false)).toBe(false);
  await manager.screenshot({ path: test.info().outputPath('startup-ready.png') });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
});

const invalidConfigurationTest = test.extend({
  launchConfiguration: [{ pythonExecutable: 'python', projectDirectory }, { option: true }],
});
invalidConfigurationTest('无效启动配置提供机器诊断，用户在 App 修正绝对路径后恢复并保存', async ({ runningApp: { app, userData }, startupDatabase }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('本机启动路径配置无效。', { exact: true })).toBeVisible();
  await prepareDatabase('migrate', startupDatabase.database);
  await manager.getByLabel('Python 可执行文件', { exact: true }).fill(pythonExecutable);
  await manager.getByLabel('项目目录', { exact: true }).fill(projectDirectory);
  await manager.getByLabel('本机配置文件', { exact: true }).fill(path.join(userData, 'synthetic.env'));
  await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
  await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
  const saved = JSON.parse(await readFile(path.join(userData, 'backend-launch.json'), 'utf8'));
  expect(saved).toEqual({ pythonExecutable, projectDirectory, envFilePath: path.join(userData, 'synthetic.env'), backendInfoPath: path.join(userData, 'backend.info') });
});

for (const [databaseState, message] of [
  ['untracked', '既有数据库缺少受管基线或迁移账本。'],
  ['drift', '数据库迁移账本或基线发生漂移。'],
  ['incomplete', '数据库必要结构不完整。'],
] as const) {
  const stateTest = test.extend({ databaseState });
  stateTest(`App 对 ${databaseState} 显示恢复说明，并阻止新后端启动`, async ({ runningApp: { app, userData } }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '设置', exact: true }).click();
    await expect(manager.getByText(message, { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
    await expect(manager.getByText(message, { exact: true })).toBeVisible();
    expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
  });
}

const pythonMissingTest = test.extend({ databaseState: 'ready',
  launchConfiguration: [{ pythonExecutable: '/synthetic/unavailable-python', projectDirectory }, { option: true }] });
pythonMissingTest('Python 缺失可在 App 修正，重试只创建一个真实后端', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('Python 可执行文件不可用。', { exact: true })).toBeVisible();
  await manager.getByLabel('Python 可执行文件', { exact: true }).fill(pythonExecutable);
  await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
  await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
  await manager.evaluate(async () => { await Promise.all([window.notalone.startup.retry(), window.notalone.startup.retry(), window.notalone.startup.retry()]); });
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible();
});

const databaseUnavailableTest = test.extend({ databaseState: 'ready',
  appEnvironment: async ({ startupDatabase }, use) => {
    const file = path.join(startupDatabase.directory, 'synthetic.env');
    await writeFile(file, `NOTALONE_DATABASE_URL=postgresql://synthetic-secret@127.0.0.1:1/${startupDatabase.database}\n`, { mode: 0o600 });
    await use({ NOTALONE_DISABLE_DOTENV: '0', NOTALONE_ENV_FILE: file, NOTALONE_DATABASE_URL: undefined,
      PATH: '/usr/bin:/bin', CONDA_PREFIX: '', CONDA_DEFAULT_ENV: '', PYTHONPATH: '/synthetic/unavailable' });
  },
});

invalidConfigurationTest('无写端 FIFO 启动配置不阻塞重试与明确退出', async ({ runningApp: { app, appProcess, userData } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('button', { name: '重试连接', exact: true })).toBeEnabled();
  const file = path.join(userData, 'backend-launch.json');
  await rm(file);
  await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', file]);
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 2500 }).toBe(0);
});
databaseUnavailableTest('数据库连接失败不回显凭据，修正独立配置后从 App 重试恢复', async ({ runningApp: { app }, startupDatabase }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('数据库暂时不可连接。', { exact: true })).toBeVisible();
  expect(await manager.locator('body').innerText()).not.toContain('synthetic-secret');
  await writeFile(path.join(startupDatabase.directory, 'synthetic.env'), `NOTALONE_DATABASE_URL='${startupDatabase.database_url}'\n`, { mode: 0o600 });
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
});

const packageMissingTest = test.extend({ databaseState: 'ready',
  launchConfiguration: async ({ startupDatabase }, use) => {
    const wrapper = path.join(startupDatabase.directory, 'python-without-packages');
    await writeFile(wrapper, `#!${pythonExecutable}\nimport os, sys\nos.execv(${JSON.stringify(pythonExecutable)}, [${JSON.stringify(pythonExecutable)}, '-S', *sys.argv[1:]])\n`);
    await chmod(wrapper, 0o700);
    await use({ pythonExecutable: wrapper, projectDirectory });
  },
});
packageMissingTest('必要 Python 包缺失与数据库错误分别显示，修正 Python 环境后恢复', async ({ runningApp: { app, userData } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('后端包或必要依赖缺失。', { exact: true })).toBeVisible();
  expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
  await manager.getByLabel('Python 可执行文件', { exact: true }).fill(pythonExecutable);
  await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
  await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
});

const readyTest = test.extend({ databaseState: 'ready' });
const ownerIncompleteTest = test.extend({ databaseState: 'owner-incomplete' });
ownerIncompleteTest('setup 必需的本人创建时间缺失会阻止启动，测试库恢复后可重试并读取真实首启状态', async ({ runningApp: { app, userData }, startupDatabase }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('数据库必要结构不完整。', { exact: true })).toBeVisible();
  expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
  await prepareDatabase('restore-owner-timestamp', startupDatabase.database);
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(manager.getByRole('region', { name: 'AI 服务' }).getByText('本人身份尚未初始化', { exact: true })).toBeVisible();
  await manager.screenshot({ path: test.info().outputPath('owner-timestamp-restored.png') });
});

readyTest('已连接时明确停服务后可修改路径，保存不会自动启动，公开重试重新连接', async ({ runningApp: { app, userData } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByLabel('后端握手文件', { exact: true })).toBeDisabled();
  await manager.getByRole('button', { name: '停止服务以修改路径', exact: true }).click();
  await expect(manager.getByLabel('后端握手文件', { exact: true })).toBeEnabled();
  expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
  const replacement = path.join(userData, 'replacement.info');
  await manager.getByLabel('后端握手文件', { exact: true }).fill(replacement);
  await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
  await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
  await expect(manager.getByText('尚未连接', { exact: true })).toBeVisible();
  expect(await access(replacement).then(() => true, () => false)).toBe(false);
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await access(replacement).then(() => true, () => false)).toBe(true);
  await manager.screenshot({ path: test.info().outputPath('startup-path-correction.png') });
});

const saveRaceTest = test.extend({ databaseState: 'drift' });
saveRaceTest('保存路径与连接重试并发时，旧路径不得启动后端或覆盖新诊断', async ({ runningApp: { app, userData }, startupDatabase }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('数据库迁移账本或基线发生漂移。', { exact: true })).toBeVisible();
  await prepareDatabase('restore-drift', startupDatabase.database);
  const result = await manager.evaluate(async () => {
    const paths = await window.notalone.startup.getPaths();
    const operations = await Promise.allSettled([
      window.notalone.startup.savePaths({ ...paths, pythonExecutable: '/synthetic/new-unavailable-python' }),
      window.notalone.backend.retryConnection(),
    ]);
    return operations.map((operation) => operation.status);
  });
  expect(result[0]).toBe('fulfilled');
  expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('Python 可执行文件不可用。', { exact: true })).toBeVisible();
  await expect(manager.getByText('尚未连接', { exact: true })).toBeVisible();
});
