import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateSigningIdentity, packageWithSigning, requireSigningMode } from '../../scripts/package-signing.mjs';
import { repositoryBuildInvocation } from '../../scripts/prepare-probe.mjs';

const certificate = 'A'.repeat(40); // 合成证书摘要，不读取本机身份。

test('签名身份缺省兼容ad-hoc，显式输入拒绝空值、控制字符和选项混淆', () => {
 assert.equal(validateSigningIdentity(), '-');
 assert.equal(validateSigningIdentity(certificate), certificate);
 for (const invalid of ['', ' ', ' identity', 'identity ', '--other', 'x\ny', 'x\0y', 12, null, 'x'.repeat(513)]) {
  assert.throws(() => validateSigningIdentity(invalid), /package_signing_identity_invalid/);
 }
});

test('App显式签名原样传递，关闭自动选身份，失败不降级或重试', async () => {
 const calls = [];
 const failure = new Error('synthetic_signing_failure');
 const options = { osxSign: { ignore: () => true, optionsForFile: () => ({ hardenedRuntime: false }) } };
 await assert.rejects(packageWithSigning(async value => { calls.push(value); throw failure; }, options, certificate),
  error => error === failure);
 assert.equal(calls.length, 1);
 assert.equal(calls[0].osxSign.identity, certificate);
 assert.equal(calls[0].osxSign.identityValidation, false);
 assert.equal(calls[0].osxSign.ignore, options.osxSign.ignore);
 assert.equal(calls[0].osxSign.optionsForFile, options.osxSign.optionsForFile);
 const result = await packageWithSigning(async value => value.osxSign.identity, options);
 assert.equal(result, '-');
});

test('自研探针只从显式参数接收相同身份，不继承外部环境选择', () => {
 const custom = repositoryBuildInvocation('/synthetic/build.sh', '/synthetic/owned', certificate);
 assert.equal(custom.options.env.NOTALONE_PROBE_SIGNING_IDENTITY, certificate);
 assert.equal(repositoryBuildInvocation('/synthetic/build.sh', '/synthetic/owned').options.env.NOTALONE_PROBE_SIGNING_IDENTITY, '-');
 assert.deepEqual(Object.keys(custom.options.env).sort(), ['NOTALONE_PROBE_MODULE_CACHE_DIR', 'NOTALONE_PROBE_SIGNING_IDENTITY', 'PATH', 'ZDOTDIR']);
 assert.throws(() => repositoryBuildInvocation('/synthetic/build.sh', '/synthetic/owned', ''), /package_signing_identity_invalid/);
});

test('产物签名方式由真实检查输出判定，证书请求遇ad-hoc或检查失败必须拒绝', async () => {
 const inspect = details => async (program, args) => {
  assert.equal(program, '/usr/bin/codesign');
  assert.deepEqual(args, ['--display', '--verbose=2', '/synthetic/app']);
  return { stderr: details };
 };
 assert.equal(await requireSigningMode('/synthetic/app', '-', inspect('Signature=adhoc\n')), 'ad-hoc');
 assert.equal(await requireSigningMode('/synthetic/app', certificate, inspect('Authority=Synthetic Test Certificate\n')), 'certificate');
 await assert.rejects(requireSigningMode('/synthetic/app', certificate, inspect('Signature=adhoc\n')), /package_signing_mode_mismatch/);
 await assert.rejects(requireSigningMode('/synthetic/app', '-', inspect('Authority=Synthetic Test Certificate\n')), /package_signing_mode_mismatch/);
 await assert.rejects(requireSigningMode('/synthetic/app', certificate, inspect('Identifier=synthetic\n')), /package_signing_mode_mismatch/);
 let calls = 0;
 await assert.rejects(requireSigningMode('/synthetic/app', certificate, async () => { calls++; throw new Error('synthetic_verify_failure'); }), /synthetic_verify_failure/);
 assert.equal(calls, 1);
});

test('公开打包入口拒绝非法或重复身份，不进入构建及钥匙串操作', { skip: process.platform !== 'darwin' }, () => {
 for (const args of [['--signing-identity'], ['--signing-identity', ''], ['--signing-identity', '--with-probe'],
  ['--signing-identity', certificate, '--signing-identity', certificate]]) {
  const result = spawnSync(process.execPath, ['scripts/package.mjs', ...args], {
   encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package_signing_identity_invalid|helper_check_arguments/);
 }
});
