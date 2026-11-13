import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './media-support.mjs';
import {SCENARIO_NOW,MINUTE,DAY,withTransaction} from './fixtures/sqlite-image-sync/scenarios.mjs';
import {imageFinalFailureCodes,imageMaxAutomaticAttempts} from '../src/media/sqlite/image-refresh.ts';

// 当前运行之前的自动尝试；适配器版本不是准备版本，按“取图失败”计数。
const VERSION='synthetic-adapter-v1';
const ATTEMPT_AT=SCENARIO_NOW-30_000;
const key=(messageId,index)=>`image_sync_v5_${messageId}_${index}`;

/** 每个联系人一条消息，失败码与次数不同，便于分别断言。 */
function seed(f,{failures}){
 return withTransaction(f.root,f.owner,seeder=>{
  const scope=seeder.contact('policy');
  const messages=Object.entries(failures).map(([name,{count,errorCode,requestedAt=ATTEMPT_AT}],index)=>{
   const message=seeder.message(scope,{displayNo:100+index});seeder.media(scope,{messageId:message.messageId});
   for(let attempt=0;attempt<count;attempt++){
    seeder.attempt(scope,{messageId:message.messageId,recordId:message.recordId,version:VERSION,requestKey:key(message.messageId,attempt),state:'failed',requestedAt,errorCode});
   }
   return [name,String(100+index)];
  });
  return {scope,display:Object.fromEntries(messages)};
 });
}
const targets=async(f,scenario,{now=SCENARIO_NOW,runtimeStartedAt}={})=>(await f.storage.execute('media.imageSyncTargets',{
 ownerId:f.owner,contactId:scenario.scope.contactId,after:'0',now,...(runtimeStartedAt===undefined?{}:{runtimeStartedAt})})).map(row=>row.displayNo);
const pending=(f,scenario,{runtimeStartedAt}={})=>f.storage.execute('media.imageRefreshPending',{
 ownerId:f.owner,contactId:scenario.scope.contactId,...(runtimeStartedAt===undefined?{}:{runtimeStartedAt})});

test('确定性失败出现一次就停止自动重试，数天后也不再按时间到期',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{failures:Object.fromEntries(imageFinalFailureCodes.map(code=>[code,{count:1,errorCode:code}]))});
 assert.equal(Object.keys(scenario.display).length,imageFinalFailureCodes.length);
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+DAY*30}),[],'确定性失败不应按时间排队');
 assert.equal(await pending(f,scenario),false,'全部停止重试后不应再安排刷新');
});

test('来源变化等非确定性的关联失败（media_association_unverified）仍会自动重试',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{failures:{transient:{count:1,errorCode:'media_association_unverified'}}});
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+MINUTE}),[scenario.display.transient]);
});

test('非确定性失败仍按 1 分钟、5 分钟…的退避重试，用满上限后停止',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{failures:Object.fromEntries(
  Array.from({length:imageMaxAutomaticAttempts+1},(_,index)=>[`n${index+1}`,{count:index+1,errorCode:'media_thumbnail_only'}]))});
 const d=scenario.display;
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+MINUTE-1}),[],'退避未到期不返回');
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+MINUTE}),[d.n1],'1 次失败后 1 分钟到期');
 // 第 5 次失败后（以及此后）不再自动重试，即使已过去很多天。
 const later=await targets(f,scenario,{now:ATTEMPT_AT+DAY*30});
 assert.deepEqual(later,[d.n1,d.n2,d.n3,d.n4],'次数用满的 n5、n6 不再到期');
});

test('停止重试的图片在 App 重启后只再试一次，本次运行内不会重复',async t=>{
 const f=await fixture(t);
 const scenario=seed(f,{failures:{final:{count:1,errorCode:'media_association_failed'},exhausted:{count:imageMaxAutomaticAttempts,errorCode:'media_thumbnail_only'}}});
 const d=scenario.display;
 // 缺省不重试；上次尝试之后才启动的运行，对每条停止重试的图片各给一次机会。
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+DAY}),[]);
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+DAY,runtimeStartedAt:ATTEMPT_AT+1}),[d.final,d.exhausted]);
 assert.equal(await pending(f,scenario,{runtimeStartedAt:ATTEMPT_AT+1}),true,'重启后的运行应安排刷新');
 // 同一运行内已经尝试过（上次尝试不早于运行开始）：不再返回，也不再安排刷新。
 assert.deepEqual(await targets(f,scenario,{now:ATTEMPT_AT+DAY,runtimeStartedAt:ATTEMPT_AT}),[]);
 assert.equal(await pending(f,scenario,{runtimeStartedAt:ATTEMPT_AT}),false);
});

test('运行开始时间必须是非负整数',async t=>{
 const f=await fixture(t),scenario=seed(f,{failures:{one:{count:1,errorCode:'media_thumbnail_only'}}});
 for(const runtimeStartedAt of [-1,1.5,'1',NaN])await assert.rejects(f.storage.execute('media.imageSyncTargets',{
  ownerId:f.owner,contactId:scenario.scope.contactId,after:'0',now:SCENARIO_NOW,runtimeStartedAt}),{code:'media_request_invalid'});
});
