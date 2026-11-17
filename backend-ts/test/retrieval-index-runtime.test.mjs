import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetrievalIndex,RETRIEVAL_EMBEDDING_FINGERPRINT} from '../src/retrieval/index-runtime.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

const vector=()=>[1,...Array(511).fill(0)];
const item=(id,text)=>({docId:id,kind:'history',id,contactId:'contact',text,bodySeal:'seal-'+id,generation:0n,modelFingerprint:RETRIEVAL_EMBEDDING_FINGERPRINT,holderKeys:['doc:'+id],coversAllContacts:false});
function store(documents=[]){
 const pending=[...documents],saved=new Map();let textBatches=1;
 return {saved,pending,async execute(name,input){
  if(name==='retrieval.syncTextBatch'){const processed=textBatches;textBatches=0;return {processed,remaining:0};}
  if(name==='retrieval.coverage')return {indexIncomplete:textBatches>0||pending.length>0};
  if(name==='retrieval.claimVectorBatch')return {items:pending.slice(0,input.limit),remaining:Math.max(0,pending.length-input.limit)};
  if(name==='retrieval.commitVectorBatch'){for(const row of input.items){saved.set(row.docId,row.vector);const index=pending.findIndex(x=>x.docId===row.docId);if(index>=0)pending.splice(index,1);}return {committed:input.items.length,rejected:0};}
  assert.fail('未知动作 '+name);
 }};
}

test('正文仅回填一次，重复查询只向模型传入query且复用持久向量',async()=>{
 const storage=store([item('a','合成正文甲'),item('b','合成正文乙')]),calls=[];
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),embed:async texts=>{calls.push([...texts]);return texts.map(vector);}});
 try{
  await index.flushForTests();
  assert.equal(storage.saved.size,2);
  const result=await index.queryVector('合成查询',new AbortController().signal);
  await index.queryVector('合成查询二',new AbortController().signal);
  await index.flushForTests();
  assert.equal(result.strategy,'hybrid');assert.equal(result.indexIncomplete,false);
  assert.deepEqual(calls,[['合成正文甲','合成正文乙'],['合成查询'],['合成查询二']]);
 }finally{await index.close();}
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('用户查询在当前小批结束后先于下一批正文推理',async()=>{
 const storage=store([item('a','正文甲'),item('b','正文乙')]),calls=[],first=deferred(),started=deferred();
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),batchSize:1,embed:async texts=>{calls.push([...texts]);if(calls.length===1){started.resolve();await first.promise;}return texts.map(vector);}});
 try{
  const filling=index.flushForTests();await started.promise;
  const query=index.queryVector('优先查询',new AbortController().signal);
  await new Promise(resolve=>setImmediate(resolve));first.resolve();
  await query;await filling;
  assert.deepEqual(calls,[['正文甲'],['优先查询'],['正文乙']]);
 }finally{first.resolve();await index.close();}
});

test('取消查询只结束等待，来源删除仍等待真实推理排空',async()=>{
 const holders=new ActiveHolders(),inference=deferred(),started=deferred(),controller=new AbortController();
 const index=createRetrievalIndex({storage:store(),ownerId:'owner',holders,embed:async()=>{started.resolve();await inference.promise;return [vector()];}});
 try{
  const result=index.queryVector('合成查询',controller.signal,{contactId:'contact',generation:0n,holderKeys:['doc:a']});
  await started.promise;controller.abort(new Error('合成取消'));
  await assert.rejects(result,/合成取消/);
  const operation={ownerId:'owner',scope:{kind:'source',contactId:'contact'},acceptedGeneration:1n};
  let drained=false;const draining=holders.drain(operation,['doc:a'],1000).then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
  inference.resolve();await draining;assert.equal(holders.verify(operation,['doc:a']),true);
 }finally{inference.resolve();await index.close();}
});

test('关闭期间的迟到正文向量不能写回且关闭等待真实推理',async()=>{
 const storage=store([item('a','合成正文')]),inference=deferred(),started=deferred();
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),embed:async()=>{started.resolve();await inference.promise;return [vector()];}});
 const filling=index.flushForTests();const rejected=assert.rejects(filling,error=>error.code==='retrieval_runtime_closed');
 await started.promise;let closed=false;const closing=index.close().then(()=>{closed=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(storage.saved.size,0);
 inference.resolve();await closing;await rejected;assert.equal(storage.saved.size,0);
});

test('本机模型缺失仍补齐FTS，模型失败保留待处理向量并退避',async()=>{
 const storage=store([item('a','合成正文')]),holders=new ActiveHolders();
 const noModel=createRetrievalIndex({storage,ownerId:'owner',holders});
 await noModel.flushForTests();
 assert.deepEqual(await noModel.queryVector('合成查询',new AbortController().signal),{strategy:'bm25',indexIncomplete:true});
 await noModel.close();
 let calls=0;const failed=createRetrievalIndex({storage,ownerId:'owner',holders,embed:async()=>{calls++;throw Error('合成本机模型缺失');}});
 try{
  await assert.rejects(failed.flushForTests(),/合成本机模型缺失/);
  assert.deepEqual(await failed.queryVector('合成查询',new AbortController().signal),{strategy:'bm25',indexIncomplete:true});
  assert.equal(calls,1);assert.equal(storage.pending.length,1);
 }finally{await failed.close();}
});

test('正文在推理期间修订导致CAS拒绝时保留待处理且本轮不循环重试',async()=>{
 const storage=store([item('a','合成正文')]);const execute=storage.execute.bind(storage);let commits=0;
 storage.execute=async(name,input)=>name==='retrieval.commitVectorBatch'?(commits++,{committed:0,rejected:input.items.length}):execute(name,input);
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),embed:async texts=>texts.map(vector)});
 try{await index.flushForTests();assert.equal(commits,1);assert.equal(storage.pending.length,1);assert.equal(storage.saved.size,0);}
 finally{await index.close();}
});

test('隔离SQLite中的L0与L1向量在索引生命周期重开后继续复用',async t=>{
 const {fixture,owner}=await import('./fixtures/memory-sqlite/support.mjs');
 const {SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);
 await new SqliteMemoryManagement(f.storage,owner).decide({requestKey:'retrieval-runtime-memory',action:'manual',scope:{scopeKind:'contact',contactId},body:'合成记忆喜欢安静的园艺活动。'});
 const calls=[],options={storage:f.storage,ownerId:owner,holders:new ActiveHolders(),embed:async texts=>{calls.push([...texts]);return texts.map(vector);}};
 const first=createRetrievalIndex(options);
 try{await first.flushForTests();}finally{await first.close();}
 const embeddedBodies=calls.flat();
 assert.equal(embeddedBodies.length,2);assert.ok(embeddedBodies.includes('合成记忆喜欢安静的园艺活动。'));
 const second=createRetrievalIndex(options);
 try{
  await second.flushForTests();assert.equal(calls.flat().length,2);
  const result=await second.queryVector('合成园艺查询',new AbortController().signal);
  assert.equal(result.strategy,'hybrid');assert.equal(result.indexIncomplete,false);
  assert.deepEqual(calls.at(-1),['合成园艺查询']);
 }finally{await second.close();}
});

test('无效前缀页不阻塞合法尾部回填，到扫描尾后不根据remaining循环重扫',async()=>{
 const storage=store([item('tail','合法尾部正文')]),execute=storage.execute.bind(storage);let scans=0;
 storage.execute=async(name,input)=>{
  if(name==='retrieval.claimVectorBatch'){
   scans++;
   if(scans===1)return {items:[],remaining:130,scanMore:true};
   if(scans===2)return {items:[item('tail','合法尾部正文')],remaining:129,scanMore:false};
   return {items:[],remaining:129,scanMore:false};
  }
  return execute(name,input);
 };
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),embed:async texts=>texts.map(vector)});
 try{await index.flushForTests();assert.equal(storage.saved.size,1);assert.equal(scans,2);}
 finally{await index.close();}
});

test('连续空扫描每轮最多64页，留待单timer续扫并可正常关闭',async()=>{
 const storage=store(),execute=storage.execute.bind(storage),atLimit=deferred();let scans=0;
 storage.execute=async(name,input)=>{
  if(name==='retrieval.claimVectorBatch'){if(++scans===64)atLimit.resolve();return {items:[],remaining:10000,scanMore:true};}
  return execute(name,input);
 };
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),embed:async texts=>texts.map(vector)});
 try{index.start();await atLimit.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(scans,64);}
 finally{await index.close();}
});

test('当前查询的联系人及本人资料先于全局长队列回填，其他联系人随后继续且覆盖状态按当前范围计算',async()=>{
 const others=Array.from({length:20},(_,n)=>({...item(`other-${n}`,`其他联系人正文${n}`),contactId:'other'}));
 const current={...item('current','当前联系人正文'),contactId:'current'},self={...item('self','本人记忆'),kind:'memory',contactId:null,coversAllContacts:true};
 const remaining=[...others,current,self],calls=[],scopes=[],globalStarted=deferred(),releaseGlobal=deferred(),currentStarted=deferred(),releaseCurrent=deferred();
 const eligible=contactId=>remaining.filter(row=>contactId===undefined||row.contactId===contactId||row.contactId===null);
 const storage={async execute(name,input){
  if(name==='retrieval.coverage')return {indexIncomplete:eligible(input.contactId).length>0};
  if(name==='retrieval.syncTextBatch'){scopes.push(input.contactId);return {processed:0,remaining:0};}
  if(name==='retrieval.claimVectorBatch'){
   const rows=eligible(input.contactId);return {items:rows.slice(0,input.limit),remaining:Math.max(0,rows.length-input.limit),scanMore:rows.length>input.limit};
  }
  if(name==='retrieval.commitVectorBatch'){
   for(const row of input.items)remaining.splice(remaining.findIndex(item=>item.docId===row.docId),1);
   return {committed:input.items.length,rejected:0};
  }
  assert.fail('未知动作 '+name);
 }};
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),batchSize:1,embed:async texts=>{
  calls.push([...texts]);
  if(texts[0]===others[0].text){globalStarted.resolve();await releaseGlobal.promise;}
  if(texts[0]===current.text){currentStarted.resolve();await releaseCurrent.promise;}
  return texts.map(vector);
 }});
 try{
  index.start();await globalStarted.promise;
  const querying=index.queryVector('当前查询',new AbortController().signal,{contactId:'current',generation:0n});
  await new Promise(resolve=>setImmediate(resolve));releaseGlobal.resolve();
  const first=await querying;assert.equal(first.indexIncomplete,true);
  assert.deepEqual(calls.slice(0,2),[[others[0].text],['当前查询']],'query优先于下一批正文推理');
  await currentStarted.promise;releaseCurrent.resolve();
  await index.flushForTests();
  assert.equal(scopes[1],'current');assert.deepEqual(calls.slice(2,4).flat().sort(),['当前联系人正文','本人记忆'].sort());
  assert.deepEqual(calls.slice(4).flat(),others.slice(1).map(row=>row.text),'优先范围完成后继续全局积压');
  remaining.push({...item('other-pending','其他联系人新增正文'),contactId:'other'});
  const second=await index.queryVector('当前查询二',new AbortController().signal,{contactId:'current',generation:0n});
  assert.equal(second.indexIncomplete,false,'其他联系人的积压不冒充当前联系人的索引缺口');
 }finally{releaseGlobal.resolve();releaseCurrent.resolve();await index.close();}
});

test('启动先准备L1小池，当前L1查询只优先联系人与本人记忆而不先回填其L0长队列',async()=>{
 const histories=Array.from({length:20},(_,n)=>({...item(`history-${n}`,`其他L0正文${n}`),contactId:'other'}));
 const currentHistory={...item('current-history','当前L0待处理'),contactId:'current'};
 const startup={...item('startup-memory','启动L1记忆'),kind:'memory',contactId:'other'};
 const self={...item('startup-self','启动本人L1记忆'),kind:'memory',contactId:null,coversAllContacts:true};
 const remaining=[...histories,currentHistory,startup,self],calls=[],requests=[],globalStarted=deferred(),releaseGlobal=deferred();
 const eligible=input=>remaining.filter(row=>(input.contactId===undefined||row.contactId===input.contactId||row.contactId===null)&&(input.kind===undefined||row.kind===input.kind));
 const storage={async execute(name,input){
  requests.push({name,contactId:input.contactId,kind:input.kind});
  if(name==='retrieval.coverage')return {indexIncomplete:eligible(input).length>0};
  if(name==='retrieval.syncTextBatch')return {processed:0,remaining:0};
  if(name==='retrieval.claimVectorBatch'){
   const rows=eligible(input);return {items:rows.slice(0,input.limit),remaining:Math.max(0,rows.length-input.limit),scanMore:rows.length>input.limit};
  }
  if(name==='retrieval.commitVectorBatch'){
   for(const row of input.items)remaining.splice(remaining.findIndex(item=>item.docId===row.docId),1);
   return {committed:input.items.length,rejected:0};
  }
  assert.fail('未知动作 '+name);
 }};
 const index=createRetrievalIndex({storage,ownerId:'owner',holders:new ActiveHolders(),batchSize:1,embed:async texts=>{
  calls.push([...texts]);if(texts[0]===histories[0].text){globalStarted.resolve();await releaseGlobal.promise;}return texts.map(vector);
 }});
 try{
  index.start();await globalStarted.promise;
  assert.deepEqual(calls.slice(0,2).flat().sort(),[startup.text,self.text].sort(),'全局大量L0在前也须先完成启动L1小池');
  const current={...item('current-memory','当前L1新增'),kind:'memory',contactId:'current'},owner={...item('current-self','本人L1新增'),kind:'memory',contactId:null,coversAllContacts:true};
  remaining.push(current,owner);
  const querying=index.queryVector('当前L1查询',new AbortController().signal,{contactId:'current',kind:'memory',generation:0n});
  await new Promise(resolve=>setImmediate(resolve));releaseGlobal.resolve();
  assert.equal((await querying).indexIncomplete,true);await index.flushForTests();
  assert.deepEqual(calls.slice(3,6).flat(),['当前L1查询',current.text,owner.text]);
  assert.deepEqual(calls.slice(6).flat(),[...histories.slice(1).map(row=>row.text),currentHistory.text],'L1优先完成后仍按全局顺序处理L0');
  assert.deepEqual(requests.filter(row=>row.name==='retrieval.claimVectorBatch').slice(0,2).map(row=>row.kind),['memory','memory']);
  assert.ok(requests.some(row=>row.name==='retrieval.syncTextBatch'&&row.contactId==='current'&&row.kind==='memory'));
  remaining.push({...item('later-history','当前L0新欠账'),contactId:'current'});
  assert.equal((await index.queryVector('当前L1再查',new AbortController().signal,{contactId:'current',kind:'memory',generation:0n})).indexIncomplete,false,'当前L0欠账不能冒充L1索引缺口');
  assert.equal(requests.filter(row=>row.name==='retrieval.coverage').at(-1).kind,'memory');
 }finally{releaseGlobal.resolve();await index.close();}
});
