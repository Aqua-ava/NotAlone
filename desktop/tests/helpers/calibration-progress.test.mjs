import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('校验尚未返回时保留固定阶段，拆包和未知原文不会进入诊断文件', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-progress-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    assert.equal(typeof profile.verificationProgressReceiver, 'function');
    const stages = [];
    const receive = profile.verificationProgressReceiver((stage) => stages.push(stage));
    assert.equal(receive(Buffer.from('synthetic private text\nnotalone_verification_sta')), true);
    assert.equal(receive(Buffer.from('ge:context\nnotalone_verification_stage:unknown\n')), true);
    assert.equal(receive(Buffer.from('notalone_verification_stage:context\n')), true);
    assert.deepEqual(stages, ['context']);
    await profile.saveVerificationProgress(owned, stages[0], () => true);
    const file = path.join(owned, 'foreground-layout-verification-progress.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { state: 'running', stage: 'context' });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await profile.invalidateCalibrationProfile(owned, false);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).stage, 'context');
    assert.equal(receive(Buffer.alloc(8193)), false);
    assert.deepEqual(stages, ['context']);
    await assert.rejects(profile.saveVerificationProgress(owned, 'synthetic private text', () => true));
    await profile.invalidateCalibrationProfile(owned);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('选区失败保存固定错误码且拒绝原生私密原文', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-failure-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    for (const error of ['calibration_coordinates_invalid', 'calibration_context_unavailable', 'calibration_window_size_changed', 'calibration_window_changed', 'calibration_probe_failed', 'calibration_probe_missing',
      'calibration_wechat_instances_ambiguous', 'calibration_wechat_version_unsupported', 'calibration_window_not_visible', 'calibration_windows_ambiguous', 'calibration_window_geometry_invalid',
      'header_name_unreadable', 'row_name_unreadable', 'session_names_mismatch', 'session_name_confidence_low']) {
      await profile.saveLayoutVerificationResult(owned, 'failed', error, 'selection', () => true);
      assert.deepEqual(JSON.parse(await readFile(path.join(owned, 'foreground-layout-verification.json'), 'utf8')),
        { state: 'failed', error, stage: 'selection' });
    }
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'synthetic private name', 'selection', () => true));
    assert.equal((await stat(path.join(owned, 'foreground-layout-verification.json'))).mode & 0o777, 0o600);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
