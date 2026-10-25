import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
test('纯 TS 公开同步在授权范围写入，发布原协议事件，关闭与撤销后停读',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-account','friend-a')",[binding,owner,contact]);
 await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,false)',[owner]);
 const executable=join(f.directory,'synthetic-cli'),log=join(f.directory,'commands.jsonl');await writeFile(log,'');
 await writeFile(executable,`#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(a[0]==='--version')emit({version:'synthetic-1'});
else if(a[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(a[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private'}]});
else if(a[0]==='resolve-chat')emit({candidates:[{username:a[1],display_name:'合成联系人',chat_type:'private'}]});
else if(a.includes('--mode'))setInterval(()=>{},1000);
else if(a[0]==='tail'){const events=a.includes('--cursor')?[]:[{type:'message',cursor:'opaque-11',message:{id:{local_id:11,talker:a[1]},kind:'text',text:'合成消息',is_from_me:false,create_time:Math.floor(Date.now()/1000)}}];emit({events,cursor:events.length?'opaque-11':null,freshness:{message_source:'live_message_db'},query:{chat:a[1],has_more:false}});}
else process.exit(2);`,{mode:0o700});
 const app=await f.start({NOTALONE_OWNER_ID:owner,NOTALONE_WECHAT_CLI:executable});
 const initial=await app.request('/api/sync/status');assert.equal(initial.status,200);assert.equal(initial.data.sync_enabled,false);
 const diagnostic=await app.request('/api/sync/follow-smoke/status');assert.equal(diagnostic.status,200);assert.equal(diagnostic.data.contacts[0].message_count,0);
 assert.deepEqual(await app.request('/api/sync/follow-smoke/start',{}),{status:409,data:{error:'follow_smoke_rejected',reason:'sync_disabled'}});
 assert.equal(await readFile(log,'utf8'),'');
 const cancel=new AbortController();
 const stream=await fetch(`http://${app.connection.address}/api/events`,{headers:{Authorization:`Bearer ${app.connection.token}`},signal:cancel.signal});
 const reader=stream.body.getReader();await reader.read();
 assert.equal((await app.request('/api/sync/enable',{})).status,200);
 const messages=await app.request(`/api/contacts/${contact}/messages`);assert.equal(messages.status,200);assert.equal(messages.data.messages.length,1);
 let text='';for(let i=0;i<8&&!text.includes('message.created');i++){text+=new TextDecoder().decode((await reader.read()).value);}
 assert.match(text,/event: message.created/);assert.match(text,/"type":"message.created"/);assert.equal(text.includes('合成消息'),false);
 assert.equal((await app.request('/api/sync/disable',{})).data.sync_enabled,false);
 const stopped=await readFile(log,'utf8');await app.request('/api/sync/check',{});assert.equal(await readFile(log,'utf8'),stopped);
 assert.equal((await app.request('/api/sync/cli-bindings/revoke',{contact_id:contact,binding_id:binding})).status,200);
 assert.deepEqual((await app.request('/api/sync/cli-bindings')).data.bindings,[]);
 cancel.abort();await reader.cancel().catch(()=>{});
 assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');assert.equal(await app.host.waitForExit(7000),true);
});
