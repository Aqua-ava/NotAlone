import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createForegroundLocationApi,isForegroundAuthorityMutation} from '../src/foreground/foreground-location-api.ts';

test('只将实际授权变更内部POST纳入门禁，状态/历史/发现保持独立',()=>{
 assert.equal(isForegroundAuthorityMutation('POST','/api/runtime/wechat-scope/revoke'),true);
 for(const operation of ['state','history-state','history-bindings','discover'])assert.equal(isForegroundAuthorityMutation('POST',`/api/runtime/wechat-scope/${operation}`),false);
 assert.equal(isForegroundAuthorityMutation('POST','/api/sync/foreground/observe'),false);
 assert.equal(isForegroundAuthorityMutation('POST','/api/sync/disable'),true);
 for(const operation of ['initialize','recover-owner'])assert.equal(isForegroundAuthorityMutation('POST',`/api/setup/${operation}`),true);
});

test('最后绑定快照后的内部撤销先使在途HTTP失效，不能发布旧confirmed',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'notalone-foreground-authority-'));let api;
 t.after(async()=>{await api?.close();await rm(directory,{recursive:true,force:true});});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();let scopes=0,releaseScope,atFinalScope,revoked=false;
 const finalScope=new Promise(resolve=>{atFinalScope=resolve;});
 const storage={runtimeOwnerId:owner,businessReadTransaction:async operation=>operation({query:async sql=>{
  if(sql.includes('LEFT JOIN')){if(++scopes===2){atFinalScope();await new Promise(resolve=>{releaseScope=resolve;});}return {rows:[{external_id:'fixture-account',enabled:true}]};}
  if(sql.includes('SELECT external_id'))return {rows:[{external_id:'fixture-account'}]};
  return {rows:revoked?[]:[{binding_id:binding,owner_id:owner,contact_id:contact,channel:'wechat',account_scope:'fixture-account',conversation_locator:'fixture-a',display_name:'合成甲友',status:'active'}]};
 }})};
 const executable=join(directory,'synthetic-cli');await writeFile(executable,"#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"data\":{\"sessions\":[{\"username\":\"fixture-a\",\"display_name\":\"合成甲友\",\"chat_type\":\"private\"}]}}'\n");await chmod(executable,0o700);
 const probe={observe:async()=>({wechat_in_front:true,display_name:'合成甲友',captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,display_name_confidence:1,name_complete:true}}),close:async()=>{},dispose:async()=>{}};
 api=await createForegroundLocationApi({storage,probe,executable});api.activate();
 const observation=api.handle('POST',Buffer.from('{}'));await finalScope;
 const operation=async()=>{revoked=true;};
 const revoke=isForegroundAuthorityMutation('POST','/api/runtime/wechat-scope/revoke')?api.changeAuthority(operation):operation();
 releaseScope();const result=await observation;await revoke;
 assert.equal(revoked,true);assert.notEqual(result.body.phase,'confirmed');assert.equal(result.status,409);
});
