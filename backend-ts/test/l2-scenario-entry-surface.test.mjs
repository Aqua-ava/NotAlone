// 特征测试：钉住 memory/scenarios 对外的导出面，并要求目录外只经入口文件导入。
// 重构前（尚无 index.ts）由 document.ts 与 workspace.ts 合并提供同一组符号，用来证明搬移前后导出面不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scenariosDir = join(root, 'src/memory/scenarios');
const entryFile = join(scenariosDir, 'index.ts');

const VALUE_SURFACE = [
  'DEFAULT_L2_SCENARIO_BUDGET',
  'L2ScenarioDocumentWorkspace',
  'L2ScenarioError',
  'L2ScenarioVerificationError',
  'UUID',
  'canonicalScenarioJSON',
  'clone',
  'count',
  'exactKeys',
  'object',
  'parseScenarioVerification',
  'readToolCalls',
  'runScenarioDocumentAgent',
  'scenarioDigest',
  'scenarioVerificationFeedback',
  'validateScenarioDocument',
  'verifyScenarioProposal',
].sort();

async function loadSurface() {
  if (existsSync(entryFile)) return {entry: true, api: await import(entryFile)};
  const [document, workspace] = await Promise.all([
    import(join(scenariosDir, 'document.ts')),
    import(join(scenariosDir, 'workspace.ts')),
  ]);
  return {entry: false, api: {...document, ...workspace}};
}

test('scenarios 入口提供约定的导出且种类不变', async () => {
  const {entry, api} = await loadSurface();
  for (const name of VALUE_SURFACE) assert.ok(name in api, name);
  for (const name of VALUE_SURFACE.filter(name => name !== 'DEFAULT_L2_SCENARIO_BUDGET' && name !== 'UUID')) {
    assert.equal(typeof api[name], 'function', name);
  }
  assert.ok(Object.isFrozen(api.DEFAULT_L2_SCENARIO_BUDGET));
  assert.ok(api.UUID instanceof RegExp);
  if (entry) assert.deepEqual(Object.keys(api).sort(), VALUE_SURFACE, '入口不得多导出内部符号');
});

test('L2 错误类保持子类关系与稳定名称', async () => {
  const {api} = await loadSurface();
  const base = new api.L2ScenarioError('l2_scenario_invalid', undefined, '细节');
  assert.ok(base instanceof Error);
  assert.equal(base.code, 'l2_scenario_invalid');
  assert.ok(new api.L2ScenarioVerificationError('l2_scenario_verification_failed', {results: []}) instanceof api.L2ScenarioError);
  assert.equal(base.name, 'L2ScenarioError');
});

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') yield* sourceFiles(path);
    } else if (/\.(ts|mjs)$/.test(name)) yield path;
  }
}

test('scenarios 目录外只能经 index.ts 导入（无入口时跳过）', {skip: !existsSync(entryFile)}, () => {
  const inner = ['document', 'workspace'].join('|');
  const deep = new RegExp(`scenarios/(?:${inner})(?:\\.ts)?['"\`]`);
  const offenders = [];
  for (const base of [join(root, 'src'), join(root, 'test')]) {
    for (const file of sourceFiles(base)) {
      if (file.startsWith(scenariosDir + '/') || file === fileURLToPath(import.meta.url)) continue;
      if (deep.test(readFileSync(file, 'utf8'))) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
