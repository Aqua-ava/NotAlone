import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile,readFile,access,symlink} from 'node:fs/promises';
import path from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {WechatHistoryCheckpointCache} from '../src/history/wechat/checkpoint-cache.ts';
const hash=(...parts)=>createHash('sha256').update(parts.join('\0')).digest('hex');
async function prepare(t){
 const f=await fixture(t),holders=new ActiveHolders(),stops=[];
 const executable=path.join(f.root,'reader','bin','wechat-cli'),cacheRoot=path.join(f.root,'wechat-history-checkpoints');
 const create=()=>new WechatHistoryCheckpointCache(f.storage,owner,holders,executable,async id=>{stops.push(id);});
 const cache=create();await cache.initialize();const scopes=[];
 for(const saved of f.saved){const token=await f.contacts.eligibility(saved.contact_id),scope=await f.storage.execute('history.scope',{token});await cache.track(scope);const file=path.join(cacheRoot,hash(scope.accountKey,scope.conversationKey)+'-'+'a'.repeat(64)+'.json');await writeFile(file,'合成页摘要',{mode:0o600});scopes.push({scope,file});}
 return {...f,holders,stops,cacheRoot,cache,create,scopes};
}
test('普通进程结束保留检查点，重启未打开渠道也可按联系人及来源删除',async t=>{
 const f=await prepare(t),first=f.scopes[0],second=f.scopes[1];
 const holders=new ActiveHolders(),reopened=new WechatHistoryCheckpointCache(f.storage,owner,holders,path.join(f.root,'reader','bin','wechat-cli'),async id=>{f.stops.push(id);});
 await reopened.initialize();await access(first.file);
 const op={ownerId:owner,scope:{kind:'source',contactId:first.scope.token.contact_id,sourceId:'synthetic'},acceptedGeneration:BigInt(first.scope.token.data_generation)+1n};
 await holders.drain(op,[],1000);assert.equal(holders.verify(op,[]),true);
 await assert.rejects(access(first.file));assert.equal(await readFile(second.file,'utf8'),'合成页摘要');assert.deepEqual(f.stops,[first.scope.token.contact_id]);
});
test('撤销清理只删除本会话派生文件，符号链接不跟随',async t=>{
 const f=await prepare(t),first=f.scopes[0],second=f.scopes[1];await f.cache.forget(first.scope.token.contact_id);await assert.rejects(access(first.file));await access(second.file);
 const foreign=path.join(f.root,'unrelated.txt');await writeFile(foreign,'保留');
 const wrong=path.join(f.root,'wechat-history-checkpoints',hash(second.scope.accountKey,second.scope.conversationKey)+'-'+'b'.repeat(64)+'.json');await symlink(foreign,wrong);
 await assert.rejects(f.cache.forget(second.scope.token.contact_id),{code:'history_checkpoint_invalid'});assert.equal(await readFile(foreign,'utf8'),'保留');
});


test('启动时清除删除前代次及已不在活跃名单中的缓存，包括未完成临时文件',async t=>{
 const f=await prepare(t),first=f.scopes[0],second=f.scopes[1];
 const binding=path.join(f.cacheRoot,'bindings',hash(owner,first.scope.token.contact_id)+'.json');
 const row=JSON.parse(await readFile(binding,'utf8'));row.generation='99';await writeFile(binding,JSON.stringify(row),{mode:0o600});
 const pending=path.join(f.cacheRoot,hash(first.scope.accountKey,first.scope.conversationKey)+'-.pending-abc42');await writeFile(pending,'合成未完成页摘要',{mode:0o600});
 const restarted=new WechatHistoryCheckpointCache(f.storage,owner,new ActiveHolders(),path.join(f.root,'reader','bin','wechat-cli'),async()=>{});await restarted.initialize();
 await assert.rejects(access(first.file));await assert.rejects(access(pending));await access(second.file);
 const emptyStorage={execute:async()=>[]};const deleted=new WechatHistoryCheckpointCache(emptyStorage,owner,new ActiveHolders(),path.join(f.root,'reader','bin','wechat-cli'),async()=>{});await deleted.initialize();await assert.rejects(access(second.file));
});
