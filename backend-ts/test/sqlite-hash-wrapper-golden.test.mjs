// 黄金摘要测试：合并 sha256 封装层（A1）必须保持逐字节输出一致。
// 期望值在替换前用旧实现 createHash('sha256').update(x).digest('hex') 生成并写死（Node v24.22.2，2026-11-07）；
// 输入覆盖空串、ASCII、中文、含 \0、含 emoji、Uint8Array 与 4 KiB 确定性字节，防止替换改变任何已持久化摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256 } from '../src/platform/sha256.ts';
import { sha } from '../src/memory/evidence/canonical-json.ts';
import { sha256 as skillSha256 } from '../src/skills/skill-package.ts';

const inputs = {
  空串: '',
  ascii: 'synthetic-ascii-fixture-42',
  chinese: '中文文本示例：关系感知回复助手',
  含nul: 'null-byte\0inside',
  emoji: 'emoji 🎉🍕 fixture',
  多行: 'line1\n中文 line2\n314159',
  字节数组: new Uint8Array([0, 1, 2, 254, 255]),
  字节4096: new Uint8Array(4096).map((_, i) => i % 251),
};
const expected = {
  空串: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ascii: 'ddda996e94f4f79c08b4e9b979b77c9952f331eb445db90f815aff9fa612d2c3',
  chinese: '2af746d30266ba7a9bcfd27d1eea72f787400a3ae3d8d4db59ae13840f27d9f8',
  含nul: '318bc31d933332e12629403c12e6fe3331edae11de3e0b9b823b46e1f80b0cde',
  emoji: 'b66c1aa46cce6d4486029565ad280b26de56717081536dc95f698d275666a868',
  多行: 'e8a8ed3b04148026e8c0034e7ce077bd36289deb14870fb140c1ac6f5cb4d8a2',
  字节数组: '103597c5abb6113da596c18e9d1da69364eafe00a2bfaa8b12e53c44bd6b0429',
  字节4096: 'd67c656e01756650d77717b0839985a056ec28ffe174601d690fc407a2ceffca',
};

test('公共 sha256 封装与替换前实现的输出逐字节相同', () => {
  for (const [name, value] of Object.entries(inputs)) {
    assert.equal(sha256(value), expected[name], `${name} 固定期望值`);
    assert.equal(sha256(value), createHash('sha256').update(value).digest('hex'), `${name} 与 createHash 实时对照`);
  }
});

test('canonical-json.sha 与 skill-package.sha256 复用同一封装且不变', () => {
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value !== 'string') continue;
    assert.equal(sha(value), expected[name], `${name} canonical-json.sha`);
    assert.equal(skillSha256(value), expected[name], `${name} skill-package.sha256`);
  }
});
