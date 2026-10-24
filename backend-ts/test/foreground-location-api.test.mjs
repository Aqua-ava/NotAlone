import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,appendFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {HostStorage} from '../src/host-storage.ts';
import {createForegroundLocationApi} from '../src/foreground-location-api.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';

test('原PG身份及开关控制定位公开合同，暂停后拒收且不写入',async t=>{
 const f=await createStorageFixture();let storage,api;
 t.after(async()=>{await api?.close();await storage?.close();await f.close();});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'合成甲友')",[owner,contact]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name) VALUES($1,$2,$3,'wechat','fixture-account','fixture-a','合成甲友')",[binding,owner,contact]);
 await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,true)',[owner]);
 await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
 storage=await HostStorage.open(f.options);
 const executable=join(f.directory,'synthetic-foreground-cli');
 // 本用例测PG门禁；用无Node冷启动成本的合成CLI保留原250ms预算。
 await writeFile(executable,`#!/bin/sh
[ "$1" = sessions ] || exit 2
case " $* " in *" --strict-read-only "*) ;; *) exit 2;; esac
case " $* " in *" all "*) ;; *) exit 2;; esac
printf '%s\\n' '{"ok":true,"data":{"sessions":[{"username":"fixture-a","display_name":"合成甲友","chat_type":"private","summary":"DO_NOT_KEEP"}]}}'
`);await chmod(executable,0o700);
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成甲友',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:0.98,name_complete:true}}),close:async()=>{},dispose:async()=>{}};
 api=await createForegroundLocationApi({storage,probe,executable});
 assert.equal((await api.handle('POST',Buffer.from('{}'))).status,409);
 api.activate();
 assert.equal((await api.handle('POST',Buffer.from('{}'))).status,503);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','fixture-account','合成账号')",[owner]);
 assert.equal((await api.handle('POST',Buffer.from('{"contact_id":"forged"}'))).status,400);
 const result=await api.handle('POST',Buffer.from('{}'));
 assert.equal(result.status,200);assert.equal(result.body.contact_id,contact,JSON.stringify(result.body));assert.equal(result.body.binding_id,binding);
 await api.invalidate();
 await f.client.query('UPDATE front_sync_state SET enabled=false WHERE owner_id=$1',[owner]);api.activate();
 const stopped=await api.handle('POST',Buffer.from('{}'));
 assert.equal(stopped.body.reason,'sync_disabled');assert.equal(stopped.body.contact_id,null);
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM message')).rows[0].n,0);
 await api.changeAuthority(async()=>{
  await f.client.query("UPDATE owner_channel_identity SET external_id='fixture-next' WHERE owner_id=$1",[owner]);
  await f.client.query("UPDATE conversation_binding SET account_scope='fixture-next' WHERE owner_id=$1",[owner]);
  await f.client.query('UPDATE front_sync_state SET enabled=true WHERE owner_id=$1',[owner]);
 });
 assert.equal((await api.handle('POST',Buffer.from('{}'))).body.contact_id,contact);

 let releaseFirst,releaseSecond,startedFirst,startedSecond;
 const firstStarted=new Promise(resolve=>{startedFirst=resolve;}),secondStarted=new Promise(resolve=>{startedSecond=resolve;});
 const first=api.changeAuthority(async()=>{startedFirst();await new Promise(resolve=>{releaseFirst=resolve;});});await firstStarted;
 const second=api.changeAuthority(async()=>{startedSecond();await new Promise(resolve=>{releaseSecond=resolve;});});await secondStarted;
 releaseFirst();await first;assert.equal((await api.handle('POST',Buffer.from('{}'))).status,409);
 releaseSecond();await second;assert.equal((await api.handle('POST',Buffer.from('{}'))).status,200);
 let releaseLast,startedLast;const lastStarted=new Promise(resolve=>{startedLast=resolve;});
 const last=api.changeAuthority(async()=>{startedLast();await new Promise(resolve=>{releaseLast=resolve;});});await lastStarted;
 await api.suspend();releaseLast();await last;assert.equal((await api.handle('POST',Buffer.from('{}'))).status,409);

});

test('最终数据库响应超过总预算时不发布已取得的联系人',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const directory=await mkdtemp(join(tmpdir(),'notalone-foreground-deadline-'));let api;
 t.after(async()=>{await api?.close();await rm(directory,{recursive:true,force:true});});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();let scopes=0,closedProbe=0;
 const storage={runtimeOwnerId:owner,businessReadTransaction:async operation=>operation({query:async sql=>{
  if(sql.includes('LEFT JOIN')){if(++scopes===2)await new Promise(resolve=>setTimeout(resolve,3250));return {rows:[{external_id:'fixture-account',enabled:true}]};}
  if(sql.includes('SELECT external_id'))return {rows:[{external_id:'fixture-account'}]};
  return {rows:[{binding_id:binding,owner_id:owner,contact_id:contact,channel:'wechat',account_scope:'fixture-account',conversation_locator:'fixture-a',display_name:'合成甲友',status:'active'}]};
 }})};
 const executable=join(directory,'synthetic-cli');await writeFile(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,data:{sessions:[{username:'fixture-a',display_name:'合成甲友',chat_type:'private'}]}}));`);await chmod(executable,0o700);
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成甲友',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:1,name_complete:true}}),close:async()=>{closedProbe++;},dispose:async()=>{}};
 api=await createForegroundLocationApi({storage,probe,executable});api.activate();
 assert.deepEqual(await api.handle('POST',Buffer.from('{}')),{status:503,body:{error:'foreground_observation_unavailable'}});
 assert.ok(closedProbe>0,'最终预算拒绝也回收原生热进程');
});
