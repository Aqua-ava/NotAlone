import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {SqliteForeground} from '../src/foreground/sqlite-foreground.ts';
function fixture(){
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),account={id:randomUUID(),key:'synthetic-account',sourceGeneration:'generation-1',revision:'1'};
 const snapshot={enabled:true,readEpoch:'1',account,bindings:[{binding_id:binding,contact_id:contact,account_id:account.id,conversation_locator:'synthetic-person',display_name:'合成联系人',status:'active',selection_generation:'1',grant_id:randomUUID(),desktopVerified:true}]};
 const rows=[{username:'synthetic-person',display_name:'合成联系人',chat_type:'private'}];
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成联系人',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:.98,name_complete:true}}),close:async()=>{},dispose:async()=>{}};
 const foreground=new SqliteForeground({ownerId:owner,probe,snapshot:async()=>structuredClone(snapshot),sessions:async()=>rows,closeSessions:async()=>{}});
 return {foreground,snapshot,rows,contact,probe};
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
