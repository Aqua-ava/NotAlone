import test from 'node:test';
import assert from 'node:assert/strict';
import {owner,fixture,record,identities} from './sqlite-clear-support.mjs';

async function terminals(t){
 const f=await fixture(t);f.state.pageRecords=[record('shard-a','1'),record('shard-a','2')];
 const sources=new Map();
 for(const contact of [f.contactA,f.contactB]){
  await f.current.history.synchronize(contact);
  sources.set(contact,(await f.current.history.read(contact)).messages.find(message=>message.text==='合成正文1').sourceRecordIds[0]);
 }
 f.state.pageRecords=[record('shard-a','1',{sender:'unknown',kind:'other',text:null,originalType:'10000',messageState:'recalled'}),record('shard-a','2')];
 for(const contact of [f.contactA,f.contactB])await f.current.history.synchronize(contact);
 return {...f,sources};
}
test('来源、联系人及账号删除真实纳入精确终态行，且不扩大到另一联系人',async t=>{
 for(const kind of ['source','contact','account'])await t.test(kind,async t=>{
  const f=await terminals(t),{history,deletion,storage}=f.current;
  const scope=kind==='account'?{kind}:kind==='source'?{kind,contactId:f.contactA,sourceId:f.sources.get(f.contactA)}:{kind,contactId:f.contactA};
  const plan=await deletion.plan({ownerId:owner,requestKey:`terminal-delete-${kind}`,scope});
  const targets=plan.targets.filter(item=>item.target?.kind==='row'&&item.target.rowKind==='history_source_terminal');
  assert.equal(targets.length,kind==='account'?2:1);
  const done=await deletion.advance(plan);assert.equal(done.state,'completed',JSON.stringify(done.checks));
  if(kind!=='account'){
   f.state.pageRecords=[record('shard-a','1'),record('shard-a','2'),record('shard-a','3')];
   await history.synchronize(f.contactB);assert.deepEqual((await history.read(f.contactB)).messages.map(message=>message.text).sort(),['合成正文2','合成正文3']);
   if(kind==='source'){await history.synchronize(f.contactA);assert.deepEqual((await history.read(f.contactA)).messages.map(message=>message.text).sort(),['合成正文2','合成正文3']);}
  }
  assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});
test('清空原始历史并显式重读后仍保留无正文终态抑制，不恢复撤回消息',async t=>{
 const f=await terminals(t),{history,clear,resync,storage}=f.current;
 f.state.boundaryMembers=identities([['shard-a','1'],['shard-a','2']]);
 assert.equal((await clear.clear(f.contactA)).completed,true);assert.equal((await history.read(f.contactA)).messages.length,0);
 f.state.pageRecords=[record('shard-a','1'),record('shard-a','2')];
 const restored=await resync.resync(f.contactA,{requestKey:'terminal-explicit-restore'});assert.equal(restored.completed,true);
 assert.deepEqual((await history.read(f.contactA)).messages.map(message=>message.text),['合成正文2']);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
