export function validateSigningIdentity(value = '-') {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512
    || /[\x00-\x1f\x7f]/.test(value) || value !== '-' && value.startsWith('-')) {
    throw new Error('package_signing_identity_invalid');
  }
  return value;
}

// 将明确身份直接交给 codesign；不搜索默认身份，失败直接传播，不降级重试。
export function packageWithSigning(packager, options, identity = '-') {
  return packager({ ...options, osxSign: { ...options.osxSign,
    identity: validateSigningIdentity(identity), identityValidation: false } });
}

// strict 校验仍由原库存流程执行；此处另核产物实际签名方式，避免把请求当作结果。
export async function requireSigningMode(file, identity, execute) {
  const expected = validateSigningIdentity(identity) === '-' ? 'ad-hoc' : 'certificate';
  const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=2', file],
    { timeout: 10000, maxBuffer: 32768, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const lines = stderr.split(/\r?\n/);
  const adhoc = lines.includes('Signature=adhoc');
  const certificate = lines.some(line => /^Authority=.+/.test(line));
  if (adhoc === certificate || (expected === 'ad-hoc') !== adhoc) throw new Error('package_signing_mode_mismatch');
  return expected;
}
