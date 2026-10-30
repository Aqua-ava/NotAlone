import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {SqliteForeground} from '../src/foreground/sqlite-foreground.ts';
import {NativeForegroundProbe} from '../src/foreground/foreground-location-probe.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
function fixture(options={}){
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),account={id:randomUUID(),key:'synthetic-account',sourceGeneration:'generation-1',revision:'1'};
 const snapshot={enabled:true,readEpoch:'1',account,bindings:[{binding_id:binding,contact_id:contact,account_id:account.id,conversation_locator:'synthetic-person',display_name:'合成联系人',status:'active',selection_generation:'1',grant_id:randomUUID(),desktopVerified:true,dataGeneration:'0',barrierGeneration:'0'}]};
 const rows=[{username:'synthetic-person',display_name:'合成联系人',chat_type:'private'}];
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成联系人',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:.98,name_complete:true}}),close:async()=>{},dispose:async()=>{}};
 const confirmations=[];
 const foreground=new SqliteForeground({ownerId:owner,probe,snapshot:async()=>structuredClone(snapshot),sessions:async()=>rows,closeSessions:async()=>{},confirmBinding:options.confirmBinding??(async proof=>{confirmations.push(proof);snapshot.bindings[0].desktopVerified=true;})});
 return {foreground,snapshot,rows,contact,probe,confirmations};
}
test('已绑定的唯一私聊自动识别，同名群聊不能误认',async()=>{
 const f=fixture();try{assert.equal((await f.foreground.observe()).contact_id,f.contact);f.rows.push({username:'synthetic@chatroom',display_name:'合成联系人',chat_type:'group'});const next=await f.foreground.observe();assert.notEqual(next.phase,'confirmed');assert.equal(next.contact_id,null);}finally{await f.foreground.close();}
});
test('授权范围变化时丢弃在途观察；同步关闭不运行探针',async()=>{
 const f=fixture();let resolve,start;const started=new Promise(r=>start=r);f.probe.observe=()=>{start();return new Promise(r=>resolve=r)};
 try{const pending=f.foreground.observe(),rejected=assert.rejects(pending);await started;const changing=f.foreground.beginChange();resolve({wechat_in_front:true,display_name:'合成联系人',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:.98,name_complete:true}});const release=await changing;await rejected;release();f.snapshot.enabled=false;const paused=await f.foreground.observe();assert.equal(paused.reason,'sync_disabled');}finally{await f.foreground.close();}
});
test('绑定发生正常变化后下一轮使用新范围而非旧快照',async()=>{
 const f=fixture();try{assert.equal((await f.foreground.observe()).phase,'confirmed');f.snapshot.readEpoch='2';assert.equal((await f.foreground.observe()).phase,'confirmed');}finally{await f.foreground.close();}
});

test('仅渠道元数据不能冒充桌面绑定，需用户选择当前联系人',async()=>{
 const f=fixture();f.snapshot.bindings[0].desktopVerified=false;try{const result=await f.foreground.observe();assert.equal(result.phase,'manual-required');assert.equal(result.reason,'unmatched_requires_selection');assert.equal(result.contact_id,null);assert.equal(result.recognized_name,'合成联系人');}finally{await f.foreground.close();}
});

test('名单中群聊名称缺失时不把同名私聊自动确认',async()=>{
 const f=fixture();f.rows.push({username:'missing@chatroom',display_name:'missing@chatroom',chat_type:'group'});try{const result=await f.foreground.observe();assert.equal(result.phase,'manual-required');assert.equal(result.contact_id,null);}finally{await f.foreground.close();}
});

test('明确桌面确认只消费当前观察，跨联系人和旧观察不能建立身份',async()=>{
 const f=fixture();f.snapshot.bindings[0].desktopVerified=false;
 try{
  const old=await f.foreground.observe(),current=await f.foreground.observe();
  await assert.rejects(f.foreground.confirm(f.contact,old.observation_id),{code:'foreground_confirmation_stale'});
  await assert.rejects(f.foreground.confirm(randomUUID(),current.observation_id),{code:'foreground_binding_required'});
  assert.equal(f.confirmations.length,0);
  assert.deepEqual(await f.foreground.confirm(f.contact,current.observation_id),{confirmed:true});
  await assert.rejects(f.foreground.confirm(f.contact,current.observation_id),{code:'foreground_confirmation_stale'});
  assert.equal((await f.foreground.observe()).contact_id,f.contact);assert.equal(f.confirmations.length,1);
 }finally{await f.foreground.close();}
});

test('桌面确认拒绝过期观察，五秒名称期限不因打开助手延长',async t=>{
 const f=fixture();f.snapshot.bindings[0].desktopVerified=false;
 try{const result=await f.foreground.observe();t.mock.method(Date,'now',()=>Date.parse(result.observed_at)+5000);
  await assert.rejects(f.foreground.confirm(f.contact,result.observation_id),{code:'foreground_confirmation_stale'});assert.equal(f.confirmations.length,0);
 }finally{await f.foreground.close();}
});

test('不完整群聊名单及同步范围变更都不允许保存桌面确认',async()=>{
 for(const change of ['incomplete','scope']){
  const f=fixture();f.snapshot.bindings[0].desktopVerified=false;if(change==='incomplete')f.rows.push({username:'missing@chatroom',display_name:'missing@chatroom',chat_type:'group'});
  try{const result=await f.foreground.observe();if(change==='scope')f.snapshot.readEpoch='2';
   await assert.rejects(f.foreground.confirm(f.contact,result.observation_id),{code:'foreground_confirmation_stale'});assert.equal(f.confirmations.length,0);
  }finally{await f.foreground.close();}
 }
});

test('桌面确认与观察和范围变更串行，在途确认不允许开始下一轮采集',async()=>{
 let release,started;const entered=new Promise(resolve=>started=resolve);
 const f=fixture({confirmBinding:async()=>{started();await new Promise(resolve=>release=resolve);}});f.snapshot.bindings[0].desktopVerified=false;
 try{
  const result=await f.foreground.observe(),pending=f.foreground.confirm(f.contact,result.observation_id),rejected=assert.rejects(pending,{code:'foreground_confirmation_stale'});
  await entered;await assert.rejects(Promise.resolve().then(()=>f.foreground.observe()),{code:'foreground_observation_busy'});
  let finished=false;const changing=f.foreground.beginChange().then(releaseChange=>{finished=true;return releaseChange;});await new Promise(setImmediate);assert.equal(finished,false);
  release();const releaseChange=await changing;await rejected;releaseChange();
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
