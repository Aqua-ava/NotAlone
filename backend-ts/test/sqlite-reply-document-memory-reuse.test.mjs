import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {documentFixture} from './fixtures/memory-documents/support.mjs';

const registryModule=new URL('./fixtures/sqlite-reply-candidates/document-registry.mjs',import.meta.url).href;
test('多篇正式文档共享同一自动记忆时，本机回复只核验一次该记忆的完整来源',async t=>{
 const measurements=[];
 for(const sceneCount of [1,8]){
  const f=await documentFixture(t,{sceneCount,registryModule});await f.extraction.start(`reply-document-source-${sceneCount}`);await f.extraction.waitForIdle();
  const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},expected=await f.storage.execute('fixture.knowledge',scope);
  const result=await f.storage.execute('fixture.measureLocalDocuments',scope);measurements.push({sceneCount,...result,ids:undefined});
  assert.equal(result.count,sceneCount+1);assert.deepEqual(result.ids,expected.map(item=>item.id));
 }
 t.diagnostic(JSON.stringify(measurements));
 for(const result of measurements){
  assert.equal(result.memoryVerificationReads,1,'共享同一自动记忆的文档不能逐篇重放相同的来源证明');
  assert.equal(result.sourceQueries,1,'记忆来源复用仍沿同一事务的本机资格范围，不能因另建代理重复查询');
 }
});

test('本机文档的记忆来源复用绑定当前事务和资格策略',async t=>{
 const f=await documentFixture(t,{sceneCount:2,registryModule});await f.extraction.start('reply-document-policy');await f.extraction.waitForIdle();
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()},result=await f.storage.execute('fixture.localDocumentMemoPolicy',scope);
 assert.ok(result.otherPolicy,'同事务的另一资格策略必须重新核验');assert.ok(result.otherTransaction,'相同策略的另一事务对象不能命中原资格');
});

for(const mutation of ['revision','deleting'])test(`本机文档来源复用在读取块退出后销毁，同事务${mutation}及后续动作重新拒绝旧资料`,async t=>{
 const f=await documentFixture(t,{sceneCount:2,registryModule});await f.extraction.start(`reply-document-mutation-${mutation}`);await f.extraction.waitForIdle();
 const scope={ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()};
 assert.deepEqual(await f.storage.execute('fixture.recheckLocalDocumentAfterMutation',{scope,mutation}),{remaining:0,errorCode:'document_knowledge_stale'});
 assert.equal((await f.storage.execute('fixture.measureLocalDocuments',scope)).count,0,'下一动作不能恢复上一动作已失效来源');
});
