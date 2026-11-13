import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './media-support.mjs';
import {SCENARIO_NOW,MINUTE,DAY,withTransaction} from './fixtures/sqlite-image-sync/scenarios.mjs';

// 当前运行之前的自动尝试；适配器版本不是准备版本，按“取图结果”计数。
const VERSION='synthetic-adapter-v1';
const ATTEMPT_AT=SCENARIO_NOW-30_000;
const key=(messageId,index)=>`image_sync_v5_${messageId}_${index}`;

/** 每个联系人一条消息，状态与失败码不同，便于分别断言。 */
function seed(f,{attempts}){
 return withTransaction(f.root,f.owner,seeder=>{
  const scope=seeder.contact('policy');
  const entries=Object.entries(attempts).map(([name,{states=[],errorCode,requestKey}],index)=>{
   const message=seeder.message(scope,{displayNo:100+index});seeder.media(scope,{messageId:message.messageId});
   states.forEach((state,attempt)=>seeder.attempt(scope,{messageId:message.messageId,recordId:message.recordId,version:VERSION,
    requestKey:requestKey?.(message.messageId,attempt)??key(message.messageId,attempt),state,requestedAt:ATTEMPT_AT,...(errorCode?{errorCode}:{})}));
   return [name,{displayNo:String(100+index),messageId:message.messageId}];
  });
  return {scope,items:Object.fromEntries(entries)};
 });
}
const targets=async(f,scenario,{now=SCENARIO_NOW}={})=>(await f.storage.execute('media.imageSyncTargets',{
 ownerId:f.owner,contactId:scenario.scope.contactId,after:'0',now})).map(row=>row.displayNo);
const pending=(f,scenario)=>f.storage.execute('media.imageRefreshPending',{ownerId:f.owner,contactId:scenario.scope.contactId});
const viewTargets=(f,scenario,messageIds,{now=SCENARIO_NOW}={})=>f.storage.execute('media.imageViewTargets',{
 ownerId:f.owner,contactId:scenario.scope.contactId,messageIds,now});

test('没有尝试过的图片到期；已有结果的图片不论失败原因都不再按时间到期',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{attempts:{
  fresh:{},
  failed:{states:['failed'],errorCode:'media_thumbnail_only'},
  association:{states:['failed'],errorCode:'media_association_failed'},
  unverified:{states:['failed'],errorCode:'media_association_unverified'},
  completed:{states:['completed']},
  many:{states:['failed','failed','failed']},
 }});
 const {items}=scenario;
 assert.deepEqual(await targets(f,scenario),[items.fresh.displayNo]);
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+DAY*30}),[items.fresh.displayNo],'数天之后也不会因为时间再入选');
});

test('被中断或撤销的自动尝试不算已有结果，仍按首次尝试处理',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{attempts:{interrupted:{states:['interrupted']},revoked:{states:['revoked']},mixed:{states:['interrupted','failed']}}});
 const {items}=scenario;
 assert.deepEqual(await targets(f,scenario),[items.interrupted.displayNo,items.revoked.displayNo]);
});

test('历史适配器与旧前缀尝试不计入自动尝试次数',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{attempts:{legacy:{states:['failed'],requestKey:messageId=>`image_sync_v3_${messageId}_0`}}});
 assert.deepEqual(await targets(f,scenario),[scenario.items.legacy.displayNo]);
});

test('只有尚未试过的图片才需要安排定时刷新',async t=>{
 const f=await fixture(t);
 const attempted=seed(f,{attempts:{failed:{states:['failed']},completed:{states:['completed']}}});
 assert.equal(await pending(f,attempted),false,'都已有结果时不再定时唤醒');
 const fresh=await fixture(t);
 const waiting=seed(fresh,{attempts:{failed:{states:['failed']},fresh:{}}});
 assert.equal(await pending(fresh,waiting),true,'仍有尚未试过的图片时需要刷新');
});

test('打开聊天：只返回仍未保存的图片，已有结果的失败图片也可再试一次',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{attempts:{
  fresh:{},
  failed:{states:['failed'],errorCode:'media_thumbnail_only'},
  association:{states:['failed'],errorCode:'media_association_failed'},
  many:{states:['failed','failed','failed','failed','failed','failed']},
 }});
 const {items}=scenario;
 const ids=Object.values(items).map(item=>item.messageId);
 const rows=await viewTargets(f,scenario,ids);
 assert.deepEqual(rows.map(row=>row.displayNo),Object.values(items).map(item=>item.displayNo),'按显示号升序返回');
 for(const row of rows)assert.match(row.requestKey,/^image_reconcile_v1_/,'打开聊天的尝试使用补查请求键');
 // 每次尝试请求键包含时间窗口，不与既有尝试撞键。
 const later=await viewTargets(f,scenario,[items.failed.messageId],{now:SCENARIO_NOW+MINUTE*2});
 assert.notEqual(later[0].requestKey,rows.find(row=>row.messageId===items.failed.messageId).requestKey);
});

test('打开聊天：不返回运行中、已清除、未请求或不存在的图片',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{attempts:{target:{states:['failed']},running:{states:['pending']},other:{states:['failed']}}});
 const {items}=scenario;
 assert.deepEqual((await viewTargets(f,scenario,[items.target.messageId,items.running.messageId,'unknown-message'])).map(row=>row.displayNo),[items.target.displayNo]);
 await withTransaction(f.root,f.owner,seeder=>{seeder.db.prepare("UPDATE message_media SET state='cleared' WHERE owner_id=? AND message_id=?").run(f.owner,items.target.messageId);});
 assert.deepEqual(await viewTargets(f,scenario,[items.target.messageId]),[],'已清除的图片不恢复');
 assert.deepEqual((await viewTargets(f,scenario,[items.other.messageId])).map(row=>row.displayNo),[items.other.displayNo]);
});

test('打开聊天：参数必须是 1～100 个合法消息 ID，时间为非负整数',async t=>{
 const f=await fixture(t),scenario=seed(f,{attempts:{one:{states:['failed']}}});
 const base={ownerId:f.owner,contactId:scenario.scope.contactId,now:SCENARIO_NOW};
 const bad=[
  {messageIds:[]},{messageIds:'x'},{messageIds:[1]},{messageIds:['a b']},{messageIds:Array.from({length:101},(_,index)=>`m${index}`)},
  {messageIds:[scenario.items.one.messageId],now:-1},{messageIds:[scenario.items.one.messageId],now:1.5},
 ];
 for(const extra of bad)await assert.rejects(f.storage.execute('media.imageViewTargets',{...base,...extra}),{code:'media_request_invalid'},JSON.stringify(extra).slice(0,60));
 assert.equal((await viewTargets(f,scenario,Array.from({length:100},(_,index)=>index===0?scenario.items.one.messageId:`m${index}`))).length,1,'恰好 100 个合法');
});
