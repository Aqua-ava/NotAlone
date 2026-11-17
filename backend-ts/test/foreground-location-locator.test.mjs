import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ForegroundLocator} from '../src/foreground/foreground-location-locator.ts';

const owner=randomUUID(), contact=randomUUID(), binding=randomUUID();
function fixture(overrides={}) {
  const observation={wechat_in_front:true,display_name:'合成甲友',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:0.98,name_complete:true}};
  const rows=[{username:'fixture-a',display_name:'合成甲友',chat_type:'private'}];
  const bindings=[{binding_id:binding,owner_id:owner,contact_id:contact,channel:'wechat',account_scope:'fixture-account',conversation_locator:'fixture-a',display_name:'合成甲友',status:'active'}];
  const probe={observe:async()=>observation,close:async()=>{},dispose:async()=>{}};
  const locator=new ForegroundLocator({ownerId:owner,accountScope:'fixture-account',probe,sessions:async()=>rows,bindings:async()=>bindings,...overrides});
  return {locator,observation,rows,bindings};
}
test('新鲜顶部名称对应唯一同范围未改名绑定才返回原UUID',async()=>{
  const f=fixture();
  const result=await f.locator.observe({enabled:true});
  assert.equal(result.phase,'confirmed');assert.equal(result.contact_id,contact);assert.equal(result.binding_id,binding);
  assert.equal(result.recognized_name,'合成甲友');assert.equal(result.reason,'confirmed_active_binding');
  await f.locator.close();
});

test('同名未绑定、群聊、改名和跨账号记录均不能授予旧联系人',async()=>{
  for(const change of [
    f=>f.rows.push({username:'fixture-unbound',display_name:'合成甲友',chat_type:'private'}),
    f=>f.rows.push({username:'fixture-group',display_name:'合成甲友',chat_type:'group'}),
    f=>{f.bindings[0].display_name='旧合成名称';},
    f=>{f.bindings[0].account_scope='other-account';},
    f=>{f.bindings[0].owner_id=randomUUID();},
    f=>{f.bindings[0].status='revoked';},
  ]) {
    const f=fixture();change(f);const result=await f.locator.observe({enabled:true});
    assert.notEqual(result.phase,'confirmed');assert.equal(result.contact_id,null);await f.locator.close();
  }
});
test('低分完整名称按名单核验保留原始分数；不完整、过期及超低分不确认',async()=>{
  const f=fixture();f.observation.quality.display_name_confidence=0.5;
  assert.equal((await f.locator.observe({enabled:true})).reason,'confirmed_active_binding_name_match');
  f.observation.quality.name_complete=false;
  assert.equal((await f.locator.observe({enabled:true})).phase,'manual-required');
  f.observation.quality.name_complete=true;f.observation.quality.display_name_confidence=0.1;
  assert.equal((await f.locator.observe({enabled:true})).phase,'manual-required');
  f.observation.captured_at=new Date(Date.now()-6000).toISOString();
  assert.equal((await f.locator.observe({enabled:true})).phase,'unavailable');await f.locator.close();
});
test('关闭和取消后迟到探针不恢复身份；新实例必须取得新观察',async()=>{
  let release,started;
  const began=new Promise(resolve=>{started=resolve;});
  const f=fixture();const old=f.observation;
  const probe={observe:()=>{started();return new Promise(resolve=>{release=resolve;});},close:async()=>{},dispose:async()=>{}};
  const g=fixture({probe});const pending=g.locator.observe({enabled:true});
  const rejected=assert.rejects(pending,e=>e.code==='foreground_observation_cancelled');
  await began;const closing=g.locator.close();release(old);await closing;await rejected;
  const fresh=fixture();fresh.observation.wechat_in_front=false;
  assert.equal((await fresh.locator.observe({enabled:true})).contact_id,null);await fresh.locator.close();await f.locator.close();
});
test('窗口上下文变化错误撤销本轮身份且保留固定错误码',async()=>{
  const f=fixture({probe:{observe:async()=>{throw Object.assign(new Error('不公开原始内容'),{code:'automatic_capture_context_changed'});},close:async()=>{},dispose:async()=>{}}});
  const result=await f.locator.observe({enabled:true});assert.equal(result.reason,'automatic_capture_context_changed');assert.equal(result.contact_id,null);assert.equal(result.recognized_name,null);await f.locator.close();
});
test('预热期间返回明确状态且不回收同一常驻Worker',async()=>{
  const f=fixture();
  let closes=0,observations=0;
  const probe={
    async observe(){observations++;if(observations===1)throw Object.assign(new Error(),{code:'probe_warming'});return f.observation;},
    async close(){closes++;},
    async dispose(){},
  };
  const locator=new ForegroundLocator({ownerId:owner,accountScope:'fixture-account',probe,sessions:async()=>f.rows,bindings:async()=>f.bindings});
  const warming=await locator.observe({enabled:true});
  assert.equal(warming.phase,'unavailable');assert.equal(warming.reason,'probe_warming');assert.equal(warming.contact_id,null);
  assert.equal(closes,0);
  const ready=await locator.observe({enabled:true});
  assert.equal(ready.phase,'confirmed');assert.equal(ready.contact_id,contact);assert.equal(closes,0);
  await locator.close();
});
test('旧双区域及最小区域协议即使名称完全命中也不能查询名单或授予联系人',async()=>{
 for(const version of ['automatic-window-v2','automatic-window-v1','minimal-region-v1']){
  let reads=0;const f=fixture({sessions:async()=>{reads++;throw new Error('旧协议不得进入名单核验');}});
  f.observation.capture_version=version;
  f.observation.selected_row_name=f.observation.display_name;
  f.observation.quality={layout_verified:true,display_name_confidence:0.99,selected_row_name_confidence:0.99};
  try{const result=await f.locator.observe({enabled:true});assert.equal(result.reason,'probe_output_invalid');assert.equal(result.contact_id,null);assert.equal(reads,0);}
  finally{await f.locator.close();}
 }
});
test('非微信前台只消费最小否定结果，不运行会话名称或绑定读取',async()=>{
 let reads=0;const f=fixture({sessions:async()=>{reads++;return [];},bindings:async()=>{reads++;return [];}});
 f.observation.wechat_in_front=false;delete f.observation.capture_version;delete f.observation.quality;
 try{assert.equal((await f.locator.observe({enabled:true})).reason,'wechat_not_in_front');assert.equal(reads,0);}
 finally{await f.locator.close();}
});
