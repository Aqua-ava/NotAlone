import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-diagnostic-export-'));
after(() => rm(directory, { recursive: true, force: true }));
const built = await build({ entryPoints: ['src/main/startup/diagnostic-export.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'subject.mjs'), built.outputFiles[0].text);
const { DiagnosticExportController } = await import(path.join(directory, 'subject.mjs'));

test('先预览后显式本机导出，白名单排除正文、身份、路径、密钥及任意异常', async () => {
  const canary = 'SENSITIVE_SYNTHETIC_CANARY';
  let choices = 0;
  const target = path.join(directory, 'report.json');
  const controller = new DiagnosticExportController(() => ({ phase: 'blocked', mode: 'external', code: 'sqlite_storage_failed',
    revision: 9, helperWarnings: ['cli_unavailable', canary], raw: canary, path: `/home/${canary}`, api_key: canary, owner_id: canary }),
  () => ({ phase: 'disconnected', errorCode: canary, reused: false, revision: 4, canRetryConnection: true,
    canRetryShutdown: false, canSaveStartupPaths: true, raw: canary }));
  const choose = async () => { choices++; return target; };
  await assert.rejects(controller.export('unpreviewed', choose), /请先预览/);
  assert.equal(choices, 0);
  const preview = controller.preview();
  const report = JSON.parse(preview.json);
  assert.equal(report.formatVersion, 1);
  assert.equal(report.startup.code, 'sqlite_storage_failed');
  assert.deepEqual(report.startup.helperWarnings, ['cli_unavailable']);
  assert.equal(report.backend.errorCode, null);
  assert.equal(report.automaticUpload, false);
  assert.equal(preview.json.includes(canary), false);
  assert.equal((await controller.export(preview.previewId, choose)).status, 'saved');
  assert.equal(await readFile(target, 'utf8'), preview.json);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(choices, 1);
});

test('取消保存、写入失败及重试不连接后台、不重放模型且只导出已预览快照', async () => {
  let phase = 'blocked';
  const controller = new DiagnosticExportController(() => ({ phase, revision: 0, helperWarnings: [] }),
    () => ({ phase: 'disconnected', canRetryConnection: true }));
  const preview = controller.preview();
  phase = 'ready';
  assert.deepEqual(await controller.export(preview.previewId, async () => undefined), { status: 'cancelled' });
  await assert.rejects(controller.export(preview.previewId, async () => path.join(directory, 'missing/report.json')), /诊断未能导出/);
  const target = path.join(directory, 'retry.json');
  assert.deepEqual(await controller.export(preview.previewId, async () => target), { status: 'saved' });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).startup.phase, 'blocked');
  const next = controller.preview();
  await assert.rejects(controller.export(preview.previewId, async () => target), /请先预览/);
  assert.equal(JSON.parse(next.json).startup.phase, 'ready');
});

test('本机导出拒绝符号链接，已有报告权限收紧为0600', async () => {
  const { symlink } = await import('node:fs/promises');
  const original = path.join(directory, 'original.json');
  const link = path.join(directory, 'report-link.json');
  await writeFile(original, '保留原文件', { mode: 0o644 });
  await symlink(original, link);
  const controller = new DiagnosticExportController(() => ({ phase: 'ready', helperWarnings: [] }), () => ({ phase: 'connected' }));
  const preview = controller.preview();
  await assert.rejects(controller.export(preview.previewId, async () => link), /诊断未能导出/);
  assert.equal(await readFile(original, 'utf8'), '保留原文件');
  await controller.export(preview.previewId, async () => original);
  assert.equal((await stat(original)).mode & 0o777, 0o600);
});
