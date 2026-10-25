// 独立断言复用固定树的合成夹具，产品源码保持原字节。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const root=process.env.REVIEW_SNAPSHOT;
const source=await readFile(join(root,'backend-ts/test/assistant-generation-publication.test.mjs'),'utf8');
const fixturePath=join(root,'backend-ts/test/spec-review-native-fixture.mjs');
await writeFile(fixturePath,source.slice(0,source.indexOf("test('纯 TS 公开异步生成完成后"))+'\nexport {publicationFixture};\n',{mode:0o600});
const {publicationFixture}=await import(pathToFileURL(fixturePath));
const {HostStorage}=await import(pathToFileURL(join(root,'backend-ts/src/host-storage.ts')));
const {createStorageFixture}=await import(pathToFileURL(join(root,'backend-ts/test/host-storage-fixture.mjs')));
const {default:pg}=await import(pathToFileURL(join(root,'backend-ts/node_modules/pg/lib/index.js')));
const require=createRequire(join(root,'desktop/package.json'));
const {build}=require('esbuild');
const bundled=await build({stdin:{contents:`
 export {retryInterruptedReply} from './src/main/reply/client';
 export {continueAssistantSession} from './src/main/reply/assistant-continuation';
 `,resolveDir:join(root,'desktop')},bundle:true,platform:'node',format:'esm',write:false});
const native=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('独立 pg 对照：冻结配置的继承回调、隐藏回调及访问器保持原生语义',{timeout:30000},async t=>{
 const f=await createStorageFixture();
 const storage=await HostStorage.open(f.options);
 t.after(async()=>{await storage.close();await f.close();});
 for(const style of ['inherited','hidden','getter']){
  const run=async client=>new Promise((resolve,reject)=>{
   let reads=0,config;
   function callback(error,result){
    if(error)return reject(error);
    try{assert.ok(this instanceof pg.Query);assert.equal(this.callback,callback);resolve({rows:result.rows,argc:arguments.length,reads});}catch(error){reject(error);}
   }
   const proto={text:'SELECT $1::integer AS n',values:[23]};
   config=Object.create(proto);
   if(style==='inherited')proto.callback=callback;
   else if(style==='hidden')Object.defineProperty(config,'callback',{value:callback});
   else Object.defineProperty(config,'callback',{get(){reads++;return callback;}});
   Object.freeze(proto);Object.freeze(config);
   assert.equal(client.query(config),undefined);
  });
  assert.deepEqual(await storage.businessTransaction(run),await run(f.client));
 }
});

for(const field of ['turn_id','input_version_id'])test(`独立原生控制器：错误 ${field} 不冒充完成，读取原保存结果后恢复`,{timeout:30000},async t=>{
 const x=await publicationFixture(t);
 x.delivery.after=(options,response)=>{if(options.path.endsWith('/replies'))response.data={...response.data,[field]:randomUUID()};};
 await x.replies.generate({...x.scope,newRequest:true});
 assert.equal(x.replies.getState().phase,'failed');
 assert.equal(x.replies.getState().result,null);
 assert.equal(x.replies.getState().generationJobs.at(-1).phase,'unconfirmed');
 await x.replies.readSavedSession(x.scope);
 assert.equal(x.replies.getState().result?.candidates.length,3);
 assert.equal(x.replies.getState().generationJobs.at(-1).phase,'completed');
 assert.equal(x.provider.requests.length,1);
});

test('独立原生控制器：生成在途取消后晚供应商输出不发布、不保存候选',{timeout:30000},async t=>{
 const x=await publicationFixture(t,{holdModel:true});
 const running=x.replies.generate({...x.scope,newRequest:true});
 try{
  await x.entered;
  const job=x.replies.getState().generationJobs.at(-1);
  await x.replies.stopGeneration({...x.scope,sessionId:job.sessionId,requestKey:job.requestKey,inputVersionId:job.inputVersionId});
  x.release();await running;
  await x.replies.readSavedSession(x.scope);
  assert.equal(x.replies.getState().result,null);
  assert.equal(x.replies.getState().generationJobs.at(-1).phase,'cancelled');
  const turn=(await x.f.client.query('SELECT state,interruption_reason FROM assistant_session_turn')).rows[0];
  assert.deepEqual(turn,{state:'failed',interruption_reason:'user_cancelled'});
  assert.equal((await x.f.client.query('SELECT count(*)::integer AS n FROM reply_candidate')).rows[0].n,0);
  assert.equal(x.provider.requests.length,1);
 }finally{x.release();await running;}
});

test('独立真实运输：中断重试恢复原输入，继续候选保留实际生效字段和嵌套讨论',{timeout:30000},async t=>{
 const x=await publicationFixture(t),session=x.replies.getState().savedSession.sessionId;
 const path=`/api/contacts/${x.contact}/assistant-sessions/${session}`;
 const body={contact_id:x.contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:'合成原输入',include_relationship_context:false},skill_disabled:true};
 const prepared=await x.client.perform({method:'POST',path:path+'/replies/prepare',body,manualContactId:x.contact});
 const interrupted=await x.client.perform({method:'POST',path:path+'/interrupt',body:{request_key:body.idempotency_key,input_version_id:prepared.data.input_version_id,reason:'app_quit'},manualContactId:x.contact});
 assert.equal(interrupted.data.state,'failed');
 const origin={turnId:prepared.data.turn_id,inputVersionId:prepared.data.input_version_id};
 const retry=await native.retryInterruptedReply(x.backend,x.contact,session,origin,randomUUID(),new AbortController().signal);
 assert.equal(retry.candidates.length,3);
 assert.deepEqual(retry.restoredInput.continuation.recovery,{original_turn_id:origin.turnId,original_input_version_id:origin.inputVersionId});
 assert.equal(retry.restoredInput.content.draft_text,'合成原输入');
 const saved=await x.client.perform({method:'GET',path,manualContactId:x.contact});
 const turn=saved.data.turns.at(-1),candidate=turn.reply.candidates[0];
 assert.equal(turn.reply.candidates.length,3);assert.equal(turn.state,'completed');
 const continued=await native.continueAssistantSession(x.backend,x.contact,session,{
  requestKey:randomUUID(),expectedInputVersionId:turn.input_version_id,instruction:'第一条，简短一点',
  displayedGroup:{sessionId:session,candidateGroupId:turn.reply.reply_request_id,candidates:[{number:1,candidateId:candidate.candidate_id,versionId:candidate.candidate_id}]},
 },new AbortController().signal);
 assert.equal(continued.phase,'completed');assert.equal(continued.candidates.length,3);
 assert.equal(continued.effectiveInput.draft_text,'合成候选1');
 assert.deepEqual(continued.effectiveRequirements,['简短一点']);
 assert.equal(x.provider.requests.length,2);
});
