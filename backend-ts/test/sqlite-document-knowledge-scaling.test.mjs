import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {documentFixture} from './fixtures/memory-documents/support.mjs';

test('整批文档复核共享一次发布集合验证，仍逐项检查投影且不跨调用缓存',async t=>{
 const measurements=[];
 for(const sceneCount of [1,15]){
  const f=await documentFixture(t,{sceneCount,registryModule:new URL('./fixtures/sqlite-reply-candidates/document-registry.mjs',import.meta.url).href});
  await f.extraction.start('document-validation-scaling');await f.extraction.waitForIdle();
  const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},before=await f.storage.execute('fixture.knowledge',scope);
  const result=await f.storage.execute('fixture.measureDocuments',scope);measurements.push(result);
  assert.equal(result.count,sceneCount+1);assert.deepEqual(result.ids,before.map(item=>item.id));
  const directory=before.find(item=>item.projection?.kind==='directory'),body=await f.storage.execute('fixture.readDocument',{...scope,item:directory,range:{startBlock:1,blockCount:1}});
  assert.equal(await f.storage.execute('fixture.requireDocuments',{...scope,items:[...before,body]}),true);
  await assert.rejects(f.storage.execute('fixture.requireDocuments',{...scope,items:[...before,{...body,text:body.text+'伪造正文'}]}),{code:'document_knowledge_stale'},'目录通过不能跳过同版本正文的独立比较');
  await assert.rejects(f.storage.execute('fixture.requireDocuments',{...scope,items:[...before,{...body,projection:{kind:'blocks',startBlock:0,blockCount:1}}]}),{code:'reply_document_range_invalid'});
  await assert.rejects(f.storage.execute('fixture.requireDocuments',{...scope,items:before.map((item,index)=>index===0?{...item,text:item.text+'伪造正文'}:item)}),{code:'document_knowledge_stale'});
  assert.equal(await f.storage.execute('fixture.recheckAfterSourceMutation',scope),'document_knowledge_stale','同事务内来源变化后的第二次校验必须重新核验');
 }
 t.diagnostic(JSON.stringify(measurements.map(({ids,...value})=>value)));
 assert.ok(measurements[1].verifyQueries<=measurements[0].verifyQueries*12,'8倍文档数量不能触发平方级重复发布集合复核');
});
