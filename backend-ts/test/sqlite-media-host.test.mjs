import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {launchDsh} from '../src/launch.ts';
import {waitForHostReady} from './host-readiness-support.mjs';
import {fixture} from './media-support.mjs';
import {writeFile,access} from 'node:fs/promises';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

test('正式DSH宿主安装媒体真实闭包，默认未认证类型不可执行，现存副本可看并单独清除',async t=>{
 const adapter={version:'synthetic-host-media-v1',supports:kind=>kind==='image',execute:async context=>{const bytes=Buffer.from('synthetic-host-image');await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});return {association:{protocol:'media-association-v1',profileId:'synthetic-host-media-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-host-resource'}};}};
 const f=await fixture(t,adapter);const message=f.messages.find(m=>m.kind==='image');const saved=await f.media.extract(f.contact,message.id,{requestKey:'host-synthetic-image',goal:'extract'});
 await f.media.close();await f.history.close();await f.contacts.close();await f.storage.close();
 const infoPath=path.join(f.root,'managed/sqlite-backend.info');const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(f.root,'unused.env'),infoPath,businessHome:f.root,environment:{},sqlite:{userData:f.root,expectedDatabaseId:f.storage.status.databaseId,role:'test',capabilities:['contacts','history']}},()=>true);t.after(()=>host.terminate());const info=await waitForHostReady(host,infoPath);
 const request=async(route,method='GET',body,headers={})=>{const response=await fetch(`http://${info.address}`+route,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 const runtime=await request('/api/runtime/status');assert.equal(runtime.body.ownership.media,'typescript');assert.equal(runtime.body.ownership.mediaExtraction,'unavailable');assert.ok(runtime.body.deletion_scopes.includes('media_result_clear'));
 const route=`/api/contacts/${f.contact}/messages/${message.id}/media`;const current=await request(route);assert.equal(current.status,200);assert.equal(current.body.files[0].fileId,saved.files[0].fileId);assert.equal(current.body.capabilities.extract,false);
 assert.equal((await request(route,'POST',{request_key:randomUUID(),goal:'extract'})).body.error,'media_adapter_unavailable');
 const preview=await request(`${route}/files/${saved.files[0].fileId}/preview`,'POST',{});assert.equal(preview.status,200);assert.equal(Buffer.from(preview.body.dataBase64,'base64').toString(),'synthetic-host-image');
 const deletion=request(route,'DELETE',undefined,{'idempotency-key':randomUUID()});
 for(let turn=0;turn<100;turn++){const status=await request(`/api/media/previews/${preview.body.sessionId}`);if(status.body.state==='revoking')break;}
 assert.equal((await request(`/api/media/previews/${preview.body.sessionId}`)).body.state,'revoking');await request(`/api/media/previews/${preview.body.sessionId}`,'DELETE');
 const cleared=await deletion;assert.equal(cleared.status,200);assert.equal(cleared.body.state,'cleared');assert.deepEqual(cleared.body.files,[]);assert.equal(cleared.body.cleanup,null);
 assert.equal((await request(`/api/contacts/${f.contact}/history-messages`)).body.messages.length,4);
 const account=await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'},{'idempotency-key':'synthetic-media-account'});assert.equal(account.status,202);const receipt=await request(`/api/deletions/${account.body.operation_id}`);assert.equal(receipt.body.state,'completed');
 assert.equal((await request('/api/runtime/shutdown','POST',{})).body.state,'stopped');assert.equal(await host.waitForExit(15000),true);
});

test('正式默认宿主暂缓语音新处理，不创建attempt或读取渠道，已有合成原件仍可清除',async t=>{
 // 只建立已有原件的业务状态，不运行语音解码或播放。
 const bytes=Buffer.from('synthetic-retained-audio-source');
 const adapter={version:'synthetic-retained-voice-v1',supports:kind=>kind==='voice',execute:async context=>{
  await context.save({role:'audio_source',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'application/octet-stream',containerValid:true,viewable:false,playable:false})});
  return {errorCode:'synthetic_conversion_deferred',association:{protocol:'media-association-v1',profileId:'synthetic-retained-voice-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-retained-voice'}};
 }};
 const f=await fixture(t,adapter),message=f.messages.find(m=>m.kind==='voice');
 const saved=await f.media.extract(f.contact,message.id,{requestKey:'synthetic-retained-voice',goal:'extract'});
 await f.contacts.setReading(false);await f.media.close();await f.history.close();await f.contacts.close();await f.storage.close();
 const marker=path.join(f.root,'channel-read'),cli=path.join(f.root,'forbidden-cli');
 await writeFile(cli,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(1);\n`,{mode:0o700});
 const infoPath=path.join(f.root,'managed/sqlite-backend.info');
 const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(f.root,'unused.env'),infoPath,businessHome:f.root,environment:{},sqlite:{userData:f.root,expectedDatabaseId:f.storage.status.databaseId,role:'test',capabilities:['contacts','history'],wechatCliPath:cli}},()=>true);
 t.after(()=>host.terminate());const info=await waitForHostReady(host,infoPath);
 const request=async(route,method='GET',body,headers={})=>{const res=await fetch(`http://${info.address}`+route,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};};
 const route=`/api/contacts/${f.contact}/messages/${message.id}/media`;
 const before=(await request(route)).body;assert.equal(before.capabilities.extract,false);assert.equal(before.capabilities.audioConversion,false);assert.deepEqual(before.files,saved.files);
 const rejected=[];
 for(const goal of ['extract','audio_conversion']){
  const requestKey=randomUUID();rejected.push({goal,requestKey});
  const result=await request(route,'POST',{request_key:requestKey,goal});assert.equal(result.status,409);assert.equal(result.body.error,'media_adapter_unavailable');
 }
 const after=(await request(route)).body;assert.deepEqual(after.latestAttempt,before.latestAttempt);assert.deepEqual(after.files,before.files);
 const cleared=await request(route,'DELETE',undefined,{'idempotency-key':randomUUID()});assert.equal(cleared.body.state,'cleared');assert.deepEqual(cleared.body.files,[]);
 assert.equal((await request(`/api/contacts/${f.contact}/history-messages`)).body.messages.length,4);
 await request('/api/runtime/shutdown','POST',{});assert.equal(await host.waitForExit(15000),true);await assert.rejects(access(marker),{code:'ENOENT'});
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.storage.status.databaseId,role:'test'});
 try{for(const input of rejected)assert.equal(await reopened.execute('media.request',{ownerId:f.owner,contactId:f.contact,messageId:message.id,...input}),null);}finally{await reopened.close();}
});
