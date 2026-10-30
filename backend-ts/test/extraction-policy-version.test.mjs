import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExtractionPolicyVersion,validateExtractionRuntimeConfig} from '../src/memory/extraction/policy-version.ts';

test('显式五键策略和旧null/v1同形校验，不借新字段升级旧任务', () => {
  for (const value of [null,{version:1,mode:'legacy',rule_set_sha256:null},
    {version:1,mode:'bounded-runtime-v1',rule_set_sha256:'a'.repeat(64)},
    {version:2,mode:'legacy',rule_set_sha256:null,verification_policy:'complete-claim-v1',source_stamp:'a'.repeat(64)}])
    assert.doesNotThrow(() => validateExtractionRuntimeConfig(value));
  const valid={version:2,mode:'legacy',rule_set_sha256:null,verification_policy:'complete-claim-v1',source_stamp:'a'.repeat(64)};
  for (const value of [{...valid,extra:true},{...valid,source_stamp:null},{...valid,source_stamp:'A'.repeat(64)},
    {...valid,verification_policy:null},{...valid,mode:'bounded-runtime-v1'},{...valid,rule_set_sha256:'a'.repeat(64)},
    {...valid,version:3},Object.fromEntries(Object.entries(valid).filter(([key])=>key!=='source_stamp'))])
    assert.throws(() => validateExtractionRuntimeConfig(value), /runtime_config_invalid/);
});

test('旧v1模式必须是字符串，不能借数组或对象强制转换通过', () => {
  for (const mode of [['bounded-runtime-v1'],['legacy'],{toString:()=> 'bounded-runtime-v1'}])
    assert.throws(() => validateExtractionRuntimeConfig({version:1,mode,rule_set_sha256:'a'.repeat(64)}), /runtime_config_invalid/);
});

test('生产提取策略来源身份锚定当前SQLite服务闭包', async () => {
  const policy=await createExtractionPolicyVersion();
  const config=policy.newTaskConfig();
  assert.equal(policy.resolve(config).verification.id,'complete-claim-v1');
  await assert.doesNotReject(policy.assertCurrent());
});

test('sourceStamp跟踪实际传递依赖及vendor，冻结后变更保守失败', async () => {
  const root=await mkdtemp(join(tmpdir(),'notalone-policy-'));
  try {
    await mkdir(join(root,'backend-ts/src'),{recursive:true});
    await writeFile(join(root,'backend-ts/package.json'),'{}');
    await writeFile(join(root,'pnpm-lock.yaml'),'lockfileVersion: 9');
    await writeFile(join(root,'backend-ts/src/entry.ts'),"import {helper} from './helper.ts'; export const policy=helper;");
    await writeFile(join(root,'backend-ts/src/helper.ts'),"export {value as helper} from './vendor.ts';");
    await writeFile(join(root,'backend-ts/src/vendor.ts'),'export const value=1;');
    const options={rootDirectory:join(root,'backend-ts/src'),entrypoints:['entry.ts']};
    const first=await createExtractionPolicyVersion(options),config=first.newTaskConfig();
    assert.equal(first.resolve(null).verification.id,'legacy-v4');
    assert.equal(first.resolve(config).verification.id,'complete-claim-v1');
    assert.equal(first.resolve(config).ruleVersion,first.resolve(structuredClone(config)).ruleVersion);
    assert.notEqual(first.resolve(config).ruleVersion,first.resolve(null).ruleVersion);
    await writeFile(join(root,'backend-ts/src/vendor.ts'),'export const value=2;');
    await assert.rejects(first.assertCurrent(),/source_unavailable/);
    const second=await createExtractionPolicyVersion(options);
    assert.notEqual(second.sourceStamp,first.sourceStamp);
    assert.throws(()=>second.resolve(config),/source_unavailable/);
    await writeFile(join(root,'pnpm-lock.yaml'),'lockfileVersion: 9\n# workspace lock drift');
    await assert.rejects(second.assertCurrent(),/source_unavailable/);
    const third=await createExtractionPolicyVersion(options);
    assert.notEqual(third.sourceStamp,second.sourceStamp);
    await writeFile(join(root,'backend-ts/src/entry.ts'),"export const load=(name)=>import(name);");
    await assert.rejects(createExtractionPolicyVersion(options),/source_unavailable/);
    await writeFile(join(root,'backend-ts/src/entry.ts'),"export const load=(suffix)=>import('./helper.ts' + suffix);");
    await assert.rejects(createExtractionPolicyVersion(options),/source_unavailable/);
  } finally {await rm(root,{recursive:true,force:true});}
});
