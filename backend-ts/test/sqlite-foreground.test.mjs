import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {SqliteForeground} from '../src/foreground/sqlite-foreground.ts';
import {NativeForegroundProbe} from '../src/foreground/foreground-location-probe.ts';
import {ForegroundLocator} from '../src/foreground/foreground-location-locator.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
function fixture(options={}){
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),account={id:randomUUID(),key:'synthetic-account',sourceGeneration:'generation-1',revision:'1'};
 const snapshot={enabled:true,readEpoch:'1',account,bindings:[{binding_id:binding,contact_id:contact,account_id:account.id,conversation_locator:'synthetic-person',display_name:'合成联系人',status:'active',grant_id:randomUUID(),selection_generation:'1',identityGeneration:'0',dataGeneration:'0',barrierGeneration:'0'}]};
 const rows=[{username:'synthetic-person',display_name:'合成联系人',chat_type:'private'}];
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成联系人',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:.98,name_complete:true}}),close:async()=>{},dispose:async()=>{}};
 const foreground=new SqliteForeground({ownerId:owner,probe,snapshot:async()=>structuredClone(snapshot),sessions:async()=>rows,closeSessions:async()=>{},requestSessionRefresh:options.requestSessionRefresh});
 return {foreground,snapshot,rows,contact,probe};
}
test('已绑定唯一私聊直接关联，同名群聊仍不能误认',async()=>{
 const f=fixture();try{
  const first=await f.foreground.observe();assert.equal(first.phase,'confirmed');assert.equal(first.contact_id,f.contact);
  f.rows.push({username:'synthetic@chatroom',display_name:'合成联系人',chat_type:'group'});
  const next=await f.foreground.observe();assert.notEqual(next.phase,'confirmed');assert.equal(next.contact_id,null);
 }finally{await f.foreground.close();}
});
test('识别置信度0.30或0.50时仍直接关联多个既有联系人，无关缺名群不全局否决',async()=>{
 const f=fixture(),names=['合成甲同学','合成乙同学'],second=randomUUID();
 f.snapshot.bindings[0].display_name=names[0];
 f.snapshot.bindings.push({...f.snapshot.bindings[0],binding_id:randomUUID(),contact_id:second,conversation_locator:'synthetic-second',display_name:names[1],grant_id:null});
 f.rows.splice(0,f.rows.length,{username:'synthetic-person',display_name:names[0],chat_type:'private'},{username:'synthetic-second',display_name:names[1],chat_type:'private'},
  ...Array.from({length:3},(_,i)=>({username:`missing-${i}@chatroom`,display_name:`missing-${i}@chatroom`,chat_type:'group'})));
 const probe=f.probe.observe;
 try{for(const [name,confidence,contact]of [[names[0],.30,f.contact],[names[1],.50,second],['合成甲同',.30,f.contact],['合成乙同',.50,second]]){
  f.probe.observe=async()=>({...await probe(),display_name:name,quality:{layout_verified:true,display_name_confidence:confidence,name_complete:true}});
  const result=await f.foreground.observe();assert.equal(result.phase,'confirmed');assert.equal(result.contact_id,contact);assert.equal(result.recognition_confidence,confidence);
 }

 }finally{await f.foreground.close();}
});
test('范围变化时丢弃在途观察；同步关闭不运行探针',async()=>{
 const f=fixture();let resolve,start;const started=new Promise(r=>start=r);f.probe.observe=()=>{start();return new Promise(r=>resolve=r)};
 try{const pending=f.foreground.observe(),rejected=assert.rejects(pending);await started;const changing=f.foreground.beginChange();resolve({wechat_in_front:true,display_name:'合成联系人',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:.98,name_complete:true}});const release=await changing;await rejected;release();f.snapshot.enabled=false;const paused=await f.foreground.observe();assert.equal(paused.reason,'sync_disabled');}finally{await f.foreground.close();}
});
test('绑定范围刷新后下一轮使用新快照',async()=>{
 const f=fixture();try{assert.equal((await f.foreground.observe()).phase,'confirmed');f.snapshot.readEpoch='2';assert.equal((await f.foreground.observe()).phase,'confirmed');}finally{await f.foreground.close();}
});
test('仅已建联稳定绑定可关联；保存名变化、重名、未知类型及过期帧仍拒绝',async()=>{
 for(const change of ['rename','duplicate','unknown','expired','no-binding']){
  const f=fixture();
  if(change==='rename')f.snapshot.bindings[0].display_name='旧的名称';
  else if(change==='duplicate')f.rows.push({username:'other-person',display_name:'合成联系人',chat_type:'private'});
  else if(change==='unknown')f.rows[0].chat_type='unknown';
  else if(change==='no-binding')f.snapshot.bindings=[];
  else{const observe=f.probe.observe;f.probe.observe=async()=>({...await observe(),captured_at:new Date(Date.now()-5001).toISOString()});}
  try{const result=await f.foreground.observe();assert.notEqual(result.phase,'confirmed',change);assert.equal(result.contact_id,null);}finally{await f.foreground.close();}
 }
});
test('前台观察只关联既有身份，不开放写桌面证明的旧确认方法',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot),result=await f.foreground.observe();
  assert.equal(result.phase,'confirmed');assert.equal(result.contact_id,f.contact);
  assert.equal('confirm' in f.foreground,false);assert.deepEqual(f.snapshot,before);
 }finally{await f.foreground.close();}
});
test('权限恢复后重试真实探针，但仍由新观察决定联系人',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-permission-recovery-')),marker=path.join(dir,'granted');
 const worker=fileURLToPath(new URL('./foreground-location-probe.fixture.mjs',import.meta.url));
 const probe=new NativeForegroundProbe({executable:process.execPath,args:[worker,'permission-recover',marker]});
 const account={id:randomUUID(),key:'synthetic-account',sourceGeneration:'synthetic',revision:'1'};
 const foreground=new SqliteForeground({ownerId:randomUUID(),probe,snapshot:async()=>({enabled:true,readEpoch:'1',account,bindings:[]}),sessions:async()=>[],closeSessions:async()=>{}});
 try{
  assert.equal((await foreground.observe()).reason,'screen_capture_permission_missing');
  await writeFile(marker,'');
  assert.equal((await foreground.observe()).reason,'screen_capture_permission_missing');
  await foreground.screenPermissionRestored();
  const result=await foreground.observe();
  assert.notEqual(result.reason,'screen_capture_permission_missing');assert.equal(result.contact_id,null);
 }finally{await foreground.close();await rm(dir,{recursive:true,force:true});}
});

for(const failingStage of ['sessions','bindings'])test(`前台${failingStage}查询暂时失败后复用OCR进程，但下一轮必须重新采帧`,async()=>{
 const worker=fileURLToPath(new URL('./foreground-location-probe.fixture.mjs',import.meta.url));
 const probe=new NativeForegroundProbe({executable:process.execPath,args:[worker,'normal']}),names=[];
 const observe=probe.observe.bind(probe);let attempt=0;
 probe.observe=async options=>{const value=await observe(options);names.push(value.display_name);return value;};
 const ownerId=randomUUID(),contactId=randomUUID(),bindingId=randomUUID();
 const locator=new ForegroundLocator({ownerId,accountScope:'synthetic-account',probe,
  sessions:async()=>{attempt++;if(failingStage==='sessions'&&attempt===1)throw new Error('synthetic_metadata_unavailable');return [{username:'synthetic-person',display_name:names.at(-1),chat_type:'private'}];},
  bindings:async()=>{if(failingStage==='bindings'&&attempt===1)throw new Error('synthetic_snapshot_unavailable');return [{owner_id:ownerId,contact_id:contactId,binding_id:bindingId,channel:'wechat',account_scope:'synthetic-account',conversation_locator:'synthetic-person',display_name:names.at(-1),status:'active'}];}});
 try{
  const failed=await locator.observe({enabled:true});
  assert.equal(failed.reason,failingStage==='sessions'?'binding_session_list_failed':'binding_verification_unavailable');assert.equal(failed.contact_id,null);assert.equal(failed.recognized_name,null);
  const recovered=await locator.observe({enabled:true});
  assert.equal(recovered.phase,'confirmed');assert.equal(recovered.contact_id,contactId);
  assert.match(names[0],/^合成\d+-1$/);
  assert.equal(names[1],names[0].replace(/-1$/,'-2'));
 }finally{await locator.close();}
});


test('账号或来源变化仍回收OCR进程，下一轮不能复用旧观察',async()=>{
 for(const code of ['foreground_scope_unavailable','history_scope_changed','history_account_changed','history_source_changed']){
  const worker=fileURLToPath(new URL('./foreground-location-probe.fixture.mjs',import.meta.url));
  const probe=new NativeForegroundProbe({executable:process.execPath,args:[worker,'normal']}),names=[];
  const observe=probe.observe.bind(probe);let attempt=0;
  probe.observe=async options=>{const value=await observe(options);names.push(value.display_name);return value;};
  const ownerId=randomUUID(),contactId=randomUUID(),bindingId=randomUUID();
  const locator=new ForegroundLocator({ownerId,accountScope:'synthetic-account',probe,
   sessions:async()=>{if(attempt++===0)throw Object.assign(new Error('synthetic_scope_changed'),{code});return [{username:'synthetic-person',display_name:names.at(-1),chat_type:'private'}];},
   bindings:async()=>[{owner_id:ownerId,contact_id:contactId,binding_id:bindingId,channel:'wechat',account_scope:'synthetic-account',conversation_locator:'synthetic-person',display_name:names.at(-1),status:'active'}]});
  try{
   const failed=await locator.observe({enabled:true});assert.equal(failed.contact_id,null);assert.equal(failed.recognized_name,null);assert.equal(failed.reason,'binding_scope_changed',code);
   assert.equal((await locator.observe({enabled:true})).phase,'confirmed');
   assert.match(names[1],/^合成\d+-1$/);assert.notEqual(names[1],names[0],code);
  }finally{await locator.close();}
 }
});

test('名称在名单中未命中或有歧义时请求后台重读，命中时不请求',async()=>{
 let refreshes=0;
 const f=fixture({requestSessionRefresh:()=>{refreshes++;}});
 try{
  assert.equal((await f.foreground.observe()).phase,'confirmed');assert.equal(refreshes,0);
  const known=f.rows.splice(0,f.rows.length);
  const missing=await f.foreground.observe();
  assert.equal(missing.phase,'manual-required');assert.equal(refreshes,1);
  f.rows.push(...known,{...known[0],username:'synthetic-duplicate'});
  const ambiguous=await f.foreground.observe();
  assert.equal(ambiguous.phase,'manual-required');assert.equal(refreshes,2);
  f.rows.splice(0,f.rows.length,...known);
  assert.equal((await f.foreground.observe()).phase,'confirmed');assert.equal(refreshes,2);
 }finally{await f.foreground.close();}
});
