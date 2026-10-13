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

test('名称质量诊断只保留有限分项数值，拒绝名字和图像且不授权profile', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-quality-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const quality = {
      display_name_confidence: 0.95, selected_row_name_confidence: 0.74, repeated_display_name_confidence: 0.96,
      display_name_width: 160, display_name_height: 48, selected_row_name_width: 160, selected_row_name_height: 40,
      pixel_scale: 2, names_duration_ms: 487,
    };
    await profile.saveLayoutVerificationResult(owned, 'failed', 'session_name_confidence_low', 'names', () => true, quality);
    const resultPath = path.join(owned, 'foreground-layout-verification.json');
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), {
      state: 'failed', error: 'session_name_confidence_low', stage: 'names', name_quality: quality,
    });
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(path.join(owned, 'foreground-layout-profile.json')), { code: 'ENOENT' });
    for (const invalid of [
      { ...quality, display_name: '合成拒绝字段' }, { ...quality, image: '合成拒绝图像' },
      { ...quality, selected_row_name_confidence: '0.74' }, { ...quality, display_name_confidence: true },
      { ...quality, repeated_display_name_confidence: NaN }, { ...quality, display_name_confidence: 1.01 },
      { ...quality, selected_row_name_width: 0 }, { ...quality, display_name_height: 1.5 },
      { ...quality, display_name_width: 160_001 }, { ...quality, pixel_scale: 4 },
      { ...quality, names_duration_ms: Infinity }, { ...quality, names_duration_ms: 400_001 },
    ]) {
      await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'session_name_confidence_low', 'names', () => true, invalid));
      assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')).name_quality, quality);
    }
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'session_name_confidence_low', 'context', () => true, quality));
    await profile.saveLayoutVerificationResult(owned, 'verified', null, 'profile', () => false, quality);
    assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).state, 'failed');
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('前台上下文诊断只保存固定分类和PID，拒绝路径、标题及不一致实例', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-context-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const context = {
      front_app_code: 'notalone', front_process_id: 321, selected_process_id: 123,
      wechat_instance_count: 1, sole_wechat_process_id: 123, sole_wechat_app_code: 'wechat_other',
      context_code: 'calibration_context_unavailable',
    };
    await profile.saveLayoutVerificationResult(owned, 'failed', 'wechat_not_in_front', 'context', () => true, undefined, context);
    const resultPath = path.join(owned, 'foreground-layout-verification.json');
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), {
      state: 'failed', error: 'wechat_not_in_front', stage: 'context', context_diagnostics: context,
    });
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(path.join(owned, 'foreground-layout-profile.json')), { code: 'ENOENT' });
    for (const invalid of [
      { ...context, bundle_path: '/synthetic/private/app' }, { ...context, window_title: '合成拒绝标题' },
      { ...context, front_app_code: '合成拒绝名字' }, { ...context, context_code: '合成拒绝原文' },
      { ...context, front_process_id: true }, { ...context, selected_process_id: 0 },
      { ...context, sole_wechat_process_id: 2147483648 }, { ...context, wechat_instance_count: 1.5 },
      { ...context, wechat_instance_count: 2 }, { ...context, front_app_code: 'none' },
    ]) {
      await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'wechat_not_in_front', 'context', () => true, undefined, invalid));
      assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')).context_diagnostics, context);
    }
    const multiple = { ...context, wechat_instance_count: 2, sole_wechat_process_id: 0,
      sole_wechat_app_code: 'none', context_code: 'calibration_wechat_instances_ambiguous' };
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'context', () => true, undefined, multiple);
    assert.equal(JSON.parse(await readFile(resultPath, 'utf8')).context_diagnostics.wechat_instance_count, 2);
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'wechat_not_in_front', 'selection', () => true, undefined, context));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('身份差项只接受四布尔且与上下文码一致，旧七字段继续兼容', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-identity-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const checks = { process_id_matches: true, window_id_matches: false,
      window_origin_matches: true, window_size_matches: true };
    const context = {
      front_app_code: 'wechat_primary', front_process_id: 123, selected_process_id: 123,
      wechat_instance_count: 1, sole_wechat_process_id: 123, sole_wechat_app_code: 'wechat_primary',
      context_code: 'identity_changed', identity_checks: checks,
    };
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'context', () => true, undefined, context);
    const resultPath = path.join(owned, 'foreground-layout-verification.json');
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')).context_diagnostics, context);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(path.join(owned, 'foreground-layout-profile.json')), { code: 'ENOENT' });
    const allMatches = { ...checks, window_id_matches: true };
    assert.deepEqual(profile.validatedContextDiagnostics({ ...context, context_code: 'matched', identity_checks: allMatches }).identity_checks, allMatches);
    for (const key of Object.keys(checks)) {
      assert.equal(profile.validatedContextDiagnostics({ ...context, identity_checks: { ...allMatches, [key]: false } }).identity_checks[key], false);
    }
    for (const invalid of [
      { ...context, identity_checks: null }, { ...context, identity_checks: [] },
      { ...context, identity_checks: { ...checks, window_title: '合成拒绝标题' } },
      { ...context, identity_checks: { ...checks, window_frame: { x: 1 } } },
      { ...context, identity_checks: { ...checks, window_id_matches: 0 } },
      { ...context, identity_checks: { ...checks, window_id_matches: 'false' } },
      { ...context, identity_checks: { process_id_matches: true } },
      { ...context, identity_checks: allMatches }, { ...context, context_code: 'matched' },
      { ...context, context_code: 'calibration_context_unavailable' },
      { ...context, context_code: 'calibration_windows_ambiguous' },
    ]) {
      await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'context', () => true, undefined, invalid));
      assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')).context_diagnostics, context);
    }
    const legacy = { ...context }; delete legacy.identity_checks;
    assert.deepEqual(profile.validatedContextDiagnostics(legacy), legacy);
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'context', () => false, undefined,
      { ...context, context_code: 'matched', identity_checks: allMatches });
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')).context_diagnostics, context);
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'verified', null, 'context', () => true, undefined, context));
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => true, undefined, context));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('输入后续修改不能更改已校验的身份差项', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-identity-copy-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const context = {
      front_app_code: 'wechat_primary', front_process_id: 123, selected_process_id: 123,
      wechat_instance_count: 1, sole_wechat_process_id: 123, sole_wechat_app_code: 'wechat_primary',
      context_code: 'identity_changed', identity_checks: { process_id_matches: true, window_id_matches: false,
        window_origin_matches: true, window_size_matches: true },
    };
    const expected = structuredClone(context);
    const validated = profile.validatedContextDiagnostics(context);
    context.context_code = 'matched';
    context.identity_checks.window_id_matches = true;
    context.identity_checks.window_title = '合成后续污染';
    assert.deepEqual(validated, expected);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
