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
