// 特征测试：钉住 memory/profiles 对外的值导出面，并要求外部只经入口文件导入。
// 重构前（尚无 index.ts）由 workspace.ts 与 document.ts 合并提供同一组符号，用来证明搬移前后导出面不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {L2ScenarioError} from '../src/memory/scenarios/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const profilesDir = join(root, 'src/memory/profiles');
const entryFile = join(profilesDir, 'index.ts');

const VALUE_SURFACE = [
  'L3ProfileDocumentError',
  'L3ProfileVerificationError',
  'L3ProfileWorkspace',
  'filterProfileProposal',
  'renderProfile',
  'runProfileDocumentAgent',
  'selectProfilePublication',
  'validateIncrementalProfile',
  'validateProfile',
  'verifyProfileProposal',
].sort();

async function loadSurface() {
  if (existsSync(entryFile)) return {entry: true, api: await import(entryFile)};
  const [workspace, document] = await Promise.all([
    import(join(profilesDir, 'workspace.ts')),
    import(join(profilesDir, 'document.ts')),
  ]);
  return {entry: false, api: {...workspace, ...document}};
}

test('profiles 入口提供约定的值导出且类型不变', async () => {
  const {entry, api} = await loadSurface();
  for (const name of VALUE_SURFACE) assert.equal(typeof api[name], 'function', name);
  if (entry) assert.deepEqual(Object.keys(api).sort(), VALUE_SURFACE, '入口不得多导出内部符号');
});

test('两类 profile 错误保持 L2ScenarioError 子类与稳定名称，且只带受限 trace', async () => {
  const {api} = await loadSurface();
  const document = new api.L3ProfileDocumentError('l3_profile_document_invalid', [], '细节');
  const verification = new api.L3ProfileVerificationError('l3_profile_verification_failed', [], '细节');
  assert.ok(document instanceof L2ScenarioError);
  assert.ok(verification instanceof L2ScenarioError);
  assert.equal(document.name, 'L3ProfileDocumentError');
  assert.equal(verification.name, 'L3ProfileVerificationError');
  assert.equal(document.code, 'l3_profile_document_invalid');
  assert.deepEqual(document.trace, []);
  assert.deepEqual(verification.trace, []);
});

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') yield* sourceFiles(path);
    } else if (/\.(ts|mjs)$/.test(name)) yield path;
  }
}

test('profiles 目录外只能经 index.ts 导入（无入口时跳过）', {skip: !existsSync(entryFile)}, () => {
  const inner = ['document', 'workspace', 'agent', 'verification'].join('|');
  const deep = new RegExp(`profiles/(?:${inner})(?:\\.ts)?['"\`]`);
  const offenders = [];
  for (const base of [join(root, 'src'), join(root, 'test')]) {
    for (const file of sourceFiles(base)) {
      if (file.startsWith(profilesDir + '/') || file === fileURLToPath(import.meta.url)) continue;
      if (deep.test(readFileSync(file, 'utf8'))) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
