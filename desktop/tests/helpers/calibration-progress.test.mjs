import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('名称采集失败分支保留原错误及位置而不生成质量或profile', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-name-branch-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const diagnostics = { failure_branch: 'context_before_capture', name_slot: 'row' };
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => true,
      undefined, undefined, diagnostics);
    const resultPath = path.join(owned, 'foreground-layout-verification.json');
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), {
      state: 'failed', error: 'minimal_region_layout_changed', stage: 'names', ...diagnostics,
    });
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(path.join(owned, 'foreground-layout-profile.json')), { code: 'ENOENT' });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('原生名称失败桥接只接受四分支、可空未知及复读三布尔', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-name-contract-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const envelope = { ok: false, error: 'minimal_region_layout_changed', verification_stage: 'names' };
    assert.equal(profile.nameFailureDiagnosticsFromResult(envelope), undefined);
    const unknown = { failure_branch: null, name_slot: null };
    assert.deepEqual(profile.nameFailureDiagnosticsFromResult({ ...envelope, ...unknown }), unknown);
    for (const failure_branch of ['context_before_capture', 'context_after_capture', 'output_size_mismatch']) {
      for (const name_slot of ['header', 'row', 'repeated_header']) {
        const diagnostic = { failure_branch, name_slot };
        assert.deepEqual(profile.nameFailureDiagnosticsFromResult({ ...envelope, ...diagnostic }), diagnostic);
      }
    }
    for (const [header_present, repeated_present] of [[true, true], [false, true], [true, false]]) {
      const diagnostic = { failure_branch: 'repeated_header_mismatch', name_slot: 'repeated_header',
        header_present, repeated_present, header_repeated_equal: false };
      assert.deepEqual(profile.nameFailureDiagnosticsFromResult({ ...envelope, ...diagnostic }), diagnostic);
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('原生名称失败桥接拒绝新失败envelope的额外根字段并保留旧格式', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-envelope-negative-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const envelope = { ok: false, error: 'minimal_region_layout_changed', verification_stage: 'names' };
    const known = { failure_branch: 'output_size_mismatch', name_slot: 'header' };
    const unknown = { failure_branch: null, name_slot: null };
    assert.deepEqual(profile.nameFailureDiagnosticsFromResult({ ...envelope, ...known }), known);
    for (const extra of [
      { name_hash: 'a'.repeat(64) }, { display_name: '合成禁止名称' }, { image: '合成禁止帧' },
      { context_diagnostics: { context_code: 'matched' } }, { arbitrary: false },
    ]) {
      assert.throws(() => profile.nameFailureDiagnosticsFromResult({ ...envelope, ...known, ...extra }));
      assert.throws(() => profile.nameFailureDiagnosticsFromResult({ ...envelope, ...unknown, ...extra }));
      assert.equal(profile.nameFailureDiagnosticsFromResult({ ...envelope, ...extra }), undefined);
    }
    const quality = { display_name_confidence: 0.8, selected_row_name_confidence: 0.8,
      repeated_display_name_confidence: 0.8, display_name_width: 180, display_name_height: 50,
      selected_row_name_width: 160, selected_row_name_height: 40, pixel_scale: 2, names_duration_ms: 600 };
    assert.deepEqual(profile.nameFailureDiagnosticsFromResult({ ...envelope, error: 'session_name_confidence_low',
      ...unknown, name_quality: quality }), unknown);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('名称失败诊断拒绝原文、摘要、非法组合并保留原已保存结果', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-calibration-name-negative-'));
  try {
    const modulePath = path.join(owned, 'profile.mjs');
    await build({ entryPoints: ['src/main/foreground/calibration-profile.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const profile = await import(pathToFileURL(modulePath).href);
    const diagnostic = { failure_branch: 'repeated_header_mismatch', name_slot: 'repeated_header',
      header_present: true, repeated_present: true, header_repeated_equal: false };
    const resultPath = path.join(owned, 'foreground-layout-verification.json');
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => true,
      undefined, undefined, diagnostic);
    const original = await readFile(resultPath, 'utf8');
    const invalids = [
      null, [], '合成拒绝原文',
      { ...diagnostic, display_name: '合成拒绝名称' }, { ...diagnostic, name_hash: 'a'.repeat(64) },
      { ...diagnostic, image: '合成拒绝图帧' }, { ...diagnostic, context_code: 'matched' },
      { ...diagnostic, failure_branch: 'unknown' }, { ...diagnostic, failure_branch: true },
      { ...diagnostic, name_slot: 'displayName' }, { ...diagnostic, name_slot: 'header' },
      { ...diagnostic, name_slot: null }, { ...diagnostic, header_present: 'true' },
      { ...diagnostic, repeated_present: 1 }, { ...diagnostic, header_repeated_equal: true },
      { ...diagnostic, header_present: false, repeated_present: false },
      { ...diagnostic, failure_branch: 'context_after_capture' },
      { failure_branch: 'context_before_capture' }, { name_slot: 'header' },
      { failure_branch: 'repeated_header_mismatch', name_slot: 'repeated_header' },
      { failure_branch: null, name_slot: 'row' }, { failure_branch: 'output_size_mismatch', name_slot: null },
      { failure_branch: null, name_slot: null, header_present: false },
    ];
    for (const invalid of invalids) {
      assert.throws(() => profile.validatedNameFailureDiagnostics(invalid));
      await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => true,
        undefined, undefined, invalid));
      assert.equal(await readFile(resultPath, 'utf8'), original);
    }
    for (const [state, error, stage] of [
      ['verified', null, 'names'], ['failed', 'minimal_region_layout_changed', 'context'],
      ['failed', 'minimal_region_layout_changed', 'sentinels-before'], ['failed', 'minimal_region_layout_changed', 'sentinels-after'],
      ['failed', 'minimal_region_capture_failed', 'names'], ['failed', 'session_name_confidence_low', 'names'],
    ]) {
      await assert.rejects(profile.saveLayoutVerificationResult(owned, state, error, stage, () => true,
        undefined, undefined, diagnostic));
      assert.equal(await readFile(resultPath, 'utf8'), original);
      assert.throws(() => profile.nameFailureDiagnosticsFromResult({ ok: state === 'verified', error, verification_stage: stage, ...diagnostic }));
    }
    await assert.rejects(profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => true,
      {}, undefined, diagnostic));
    assert.throws(() => profile.nameFailureDiagnosticsFromResult({ ok: false, error: 'minimal_region_layout_changed',
      verification_stage: 'names', name_quality: {}, ...diagnostic }));
    await profile.saveLayoutVerificationResult(owned, 'failed', 'minimal_region_layout_changed', 'names', () => false,
      undefined, undefined, { failure_branch: null, name_slot: null });
    assert.equal(await readFile(resultPath, 'utf8'), original);
    const copy = profile.validatedNameFailureDiagnostics(diagnostic);
    diagnostic.header_present = false;
    assert.equal(copy.header_present, true);
    await profile.saveLayoutVerificationResult(owned, 'failed', 'session_name_confidence_low', 'names', () => true,
      undefined, undefined, { failure_branch: null, name_slot: null });
    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), { state: 'failed', error: 'session_name_confidence_low',
      stage: 'names', failure_branch: null, name_slot: null });
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(path.join(owned, 'foreground-layout-profile.json')), { code: 'ENOENT' });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

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
