import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPackage} from '../src/skills/skill-package.ts';

const document = '---\nname: gentle-reply\ndescription: "用于回应感受"\n---\n\n先回应感受。\n';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'notalone-skill-package-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const input = join(dir, 'input', 'gentle-reply');
  mkdirSync(input, {recursive: true});
  writeFileSync(join(input, 'SKILL.md'), document);
  return {dir, input};
}

test('包及资源拒绝链接，外部文件不变', t => {
  const {input, dir} = fixture(t), outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), '保留');
  symlinkSync(outside, join(input, 'references'));
  assert.throws(() => readPackage(input));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), '保留');
});

test('包清洗拒绝脚本、外部URL、私人导出、重复YAML键和超预算内容', t => {
  const {input} = fixture(t);
  for (const body of ['访问外部网络', 'https://example.invalid/test', 'sender_wxid: fake', '执行脚本', '先回应。\n'.repeat(501), '字'.repeat(5001)]) {
    writeFileSync(join(input, 'SKILL.md'), document + body);
    assert.throws(() => readPackage(input));
  }
  writeFileSync(join(input, 'SKILL.md'), document.replace('name: gentle-reply', 'name: wrong\nname: gentle-reply'));
  assert.throws(() => readPackage(input));
  writeFileSync(join(input, 'SKILL.md'), document + '禁止执行脚本。');
  assert.doesNotThrow(() => readPackage(input));
  mkdirSync(join(input, 'assets'));
  writeFileSync(join(input, 'assets', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>');
  assert.throws(() => readPackage(input));
  writeFileSync(join(input, 'assets', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>示例</text></svg>');
  assert.doesNotThrow(() => readPackage(input));
  writeFileSync(join(input, 'assets', 'a.svg'), Buffer.alloc(1024 * 1024 + 1, 32));
  assert.throws(() => readPackage(input));
});

test('资源数量与合计预算在读取时受限', t => {
  const {input} = fixture(t);
  mkdirSync(join(input, 'references'));
  for (let i = 0; i < 101; i++) writeFileSync(join(input, 'references', `${i}.txt`), '合成');
  assert.throws(() => readPackage(input), error => error.code === 'resource_count_exceeded');
  rmSync(join(input, 'references'), {recursive: true});
  mkdirSync(join(input, 'references'));
  for (let i = 0; i < 5; i++) writeFileSync(join(input, 'references', `${i}.txt`), Buffer.alloc(1024 * 1024, 32));
  assert.throws(() => readPackage(input), error => error.code === 'resource_budget_exceeded');
});

test('沿用Python splitlines的CR及Unicode分行，500行不能经Unicode分隔符绕过', t => {
  const {input} = fixture(t);
  writeFileSync(join(input, 'SKILL.md'), document.replaceAll('\n', '\r'));
  assert.equal(readPackage(input).content, '先回应感受。\r');
  for (const separator of ['\r', '\u0085', '\u2028', '\u2029', '\v', '\f', '\x1c', '\x1d', '\x1e']) {
    writeFileSync(join(input, 'SKILL.md'), document + '行' + (separator + '行').repeat(501));
    assert.throws(() => readPackage(input), error => error.code === 'skill_size_exceeded');
  }
});

test('显式选择包根的任意祖先链接不能借canonicalRoot洗掉', t => {
  const {dir} = fixture(t);
  symlinkSync(join(dir, 'input'), join(dir, 'alias'));
  assert.throws(() => readPackage(join(dir, 'alias', 'gentle-reply')), error => error.code === 'symlink_not_allowed');
});

test('Unicode换行后危险指令不能沿用上一行否定词', t => {
  const {input} = fixture(t);
  for (const separator of ['\r', '\u0085', '\u2028']) {
    writeFileSync(join(input, 'SKILL.md'), document + '禁止操作' + separator + '执行脚本');
    assert.throws(() => readPackage(input), error => error.code === 'unsafe_instruction');
  }
});

test('瞬时读取故障与非法包分开且异常不带路径', t => {
  const {input} = fixture(t);
  rmSync(join(input, 'SKILL.md'));
  assert.throws(() => readPackage(input), error => error.name === 'SkillPackageReadError' && error.code === 'file_unavailable' && !error.message.includes(input));
  writeFileSync(join(input, 'SKILL.md'), '非法包');
  assert.throws(() => readPackage(input), error => error.name === 'SkillPackageError');
});
