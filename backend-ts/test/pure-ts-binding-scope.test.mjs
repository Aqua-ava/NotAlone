import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {HostStorage} from '../src/host-storage.ts';
import {resolvePublicReplyScope,withPublicReplyScope,resolveRequestBinding,withoutPublicReplyScope} from '../src/pure-ts-reply-scope.ts';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
test('重叠manual/desktop请求不串同scope或跨scope身份，结束与后台调用回默认',{timeout:10000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contacts=[randomUUID(),randomUUID()],desktop=[randomUUID(),randomUUID()],manual=[randomUUID(),randomUUID()];
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 for(let i=0;i<2;i++){
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contacts[i],owner]);
  await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator)VALUES($1,$2,$3,'wechat','synthetic',$4)",[desktop[i],owner,contacts[i],'friend-'+i]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[manual[i],owner,contacts[i]]);
 }
 const storage=await HostStorage.open({envFilePath:join(f.directory,'runtime.env'),migrationsDirectory:resolve('../backend-ts/database/migrations'),environment:{NOTALONE_OWNER_ID:owner}});f.cleanup(()=>storage.close());
 const clients=await Promise.all([0,1].map(async()=>{const client=new pg.Client({host:'/tmp',database:f.client.database});await client.connect();return client;}));f.cleanup(async()=>{for(const client of clients)await client.end();});
 const scopeA={owner_id:owner,contact_id:contacts[0]},scopeB={owner_id:owner,contact_id:contacts[1]};
 const verifiedManual=await resolvePublicReplyScope(storage,contacts[0],true),verifiedDesktop=await resolvePublicReplyScope(storage,contacts[0]);
 let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
 const first=withPublicReplyScope(verifiedManual,async()=>{enter();await gate;return resolveRequestBinding(clients[0],scopeA);});
 await entered;
 const second=withPublicReplyScope(verifiedDesktop,async()=>{release();return resolveRequestBinding(clients[1],scopeA);});
 assert.deepEqual(await Promise.all([first,second]),[manual[0],desktop[0]]);
 const cross=await Promise.all([
  withPublicReplyScope(verifiedManual,()=>resolveRequestBinding(clients[0],scopeA)),
  withPublicReplyScope(await resolvePublicReplyScope(storage,contacts[1]),()=>resolveRequestBinding(clients[1],scopeB)),
 ]);assert.deepEqual(cross,[manual[0],desktop[1]]);
 await assert.rejects(withPublicReplyScope(verifiedManual,()=>resolveRequestBinding(clients[0],scopeB)),{reason:'binding_changed'});
 assert.equal(await resolveRequestBinding(clients[0],scopeA),desktop[0]);
 assert.equal(await withPublicReplyScope(verifiedManual,()=>withoutPublicReplyScope(()=>resolveRequestBinding(clients[0],scopeA))),desktop[0]);
 let background,allowBackground;const backgroundGate=new Promise(resolve=>allowBackground=resolve);
 await withPublicReplyScope(verifiedManual,async()=>{background=(async()=>{await backgroundGate;return resolveRequestBinding(clients[0],scopeA);})();});
 allowBackground();assert.equal(await background,desktop[0],'继承请求但在请求结束后运行的任务不保留manual身份');
});
