import test from 'node:test';
import assert from 'node:assert/strict';
import {documentSourceGrowthFixture} from './fixtures/memory-documents/document-source-growth.mjs';

test('主题文档领取保留完整记忆池，同一来源资格不随记忆数量重复核验',{timeout:30_000},async t=>{
 const small=await documentSourceGrowthFixture(t,10),large=await documentSourceGrowthFixture(t,100);
 const before=small.scene(),after=large.scene();
 t.diagnostic(JSON.stringify({small:{memories:10,distinctSources:small.distinctSources,...before},large:{memories:100,distinctSources:large.distinctSources,...after}}));
 assert.equal(before.memoryCount,10);assert.equal(after.memoryCount,100,'优化不能截断主题文档输入的完整记忆池');
 assert.equal(before.sourceMessageCount,1);assert.equal(after.sourceMessageCount,1);
 assert.equal(small.calls.length,0);assert.equal(large.calls.length,0,'领取文档步骤不能派发模型');
 assert.deepEqual(await small.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.deepEqual(await large.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.ok(before.sourceQualificationQueries<=small.distinctSources,'同一来源应只解析一次当前资格');
 assert.ok(after.sourceQualificationQueries<=large.distinctSources,'共享来源的记忆增长不能重复核验同一当前来源');
});

for(const failure of ['revoked','deleting'])test(`新的主题文档动作拒绝${failure==='revoked'?'已撤销授权':'正在删除'}的来源，不复用旧资格`,async t=>{
 const f=await documentSourceGrowthFixture(t,10);assert.equal(f.scene().memoryCount,10);
 if(failure==='revoked'){
  const binding=f.saved.find(value=>value.contact_id===f.contactId);
  await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 }else f.deletingSource();
 assert.throws(()=>f.scene(),error=>['memory_extraction_scope_stale','memory_extraction_output_not_eligible','history_source_not_available','document_source_stale','memory_source_stale'].includes(error.code));
 assert.equal(f.calls.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
