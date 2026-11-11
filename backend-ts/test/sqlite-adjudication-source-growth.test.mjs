import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceGrowthFixture} from './fixtures/memory-management/adjudication-source-growth.mjs';

test('裁决父池增长时保留全部比较对象，同一合法来源的资格查询保持有界',{timeout:30_000},async t=>{
 const small=await sourceGrowthFixture(t,10),large=await sourceGrowthFixture(t,100);
 const before=small.probe(),after=large.probe();
 t.diagnostic(JSON.stringify({small:{parents:10,distinctSources:small.distinctSources,...before},large:{parents:100,distinctSources:large.distinctSources,...after}}));
 assert.equal(before.parentCount,10);assert.equal(before.similarCount,10);
 assert.equal(after.parentCount,100);assert.equal(after.similarCount,100,'优化不能截断冻结的完整比较池');
 assert.equal(small.calls.length,0);assert.equal(large.calls.length,0,'领取步骤不触发任何裁决模型调用');
 assert.deepEqual(await small.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.deepEqual(await large.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.ok(before.sourceQualificationQueries<=small.distinctSources,'同一来源不能因重复父引用多次核验当前范围');
 assert.ok(after.sourceQualificationQueries<=large.distinctSources,'父池增长不能重复解析同一来源授权');
});

test('新的裁决领取动作复验当前授权，不能沿用上次来源资格快照',async t=>{
 const f=await sourceGrowthFixture(t,10),before=f.probe();assert.equal(before.parentCount,10);
 const binding=f.saved.find(value=>value.contact_id===f.contactId);
 await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 assert.throws(()=>f.probe(),error=>['memory_extraction_scope_stale','memory_extraction_output_not_eligible','history_source_not_available'].includes(error.code));
 assert.equal(f.calls.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
