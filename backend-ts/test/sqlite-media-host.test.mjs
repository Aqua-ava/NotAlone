import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,watch} from 'node:fs';
import {readFile as readText} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {launchDsh} from '../src/launch.ts';
import {fixture} from './media-support.mjs';

async function handshake(infoPath){
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);watcher.close();error?reject(error):resolve(value);};
  const load=async()=>{try{const text=await readText(infoPath,'utf8');finish(null,Object.fromEntries(text.trim().split('\n').map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1)];})));}catch(error){if(error.code!=='ENOENT')finish(error);}};
  const watcher=watch(path.dirname(infoPath),(_event,file)=>{if(String(file)===path.basename(infoPath))void load();});const timer=setTimeout(()=>finish(new Error('正式媒体宿主未就绪')),15000);void load();
 });
}
test('正式DSH宿主安装媒体真实闭包，默认未认证类型不可执行，现存副本可看并单独清除',async t=>{
 const adapter={version:'synthetic-host-media-v1',supports:kind=>kind==='image',execute:async context=>{const bytes=Buffer.from('synthetic-host-image');await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'thumbnail',qualityProof:null})});return {association:{protocol:'media-association-v1',profileId:'synthetic-host-media-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-host-resource'}};}};
 const f=await fixture(t,adapter);const message=f.messages.find(m=>m.kind==='image');const saved=await f.media.extract(f.contact,message.id,{requestKey:'host-synthetic-image',goal:'extract'});
 await f.media.close();await f.history.close();await f.contacts.close();await f.storage.close();
 const infoPath=path.join(f.root,'managed/sqlite-backend.info');const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(f.root,'unused.env'),infoPath,businessHome:f.root,environment:{},sqlite:{userData:f.root,expectedDatabaseId:f.storage.status.databaseId,role:'test',capabilities:['contacts','history']}},()=>true);t.after(()=>host.terminate());const info=await handshake(infoPath);
 const request=async(route,method='GET',body,headers={})=>{const response=await fetch(`http://${info.address}`+route,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 const runtime=await request('/api/runtime/status');assert.equal(runtime.body.ownership.media,'typescript');assert.equal(runtime.body.ownership.mediaExtraction,'unavailable');assert.ok(runtime.body.deletion_scopes.includes('media_result_clear'));
 const route=`/api/contacts/${f.contact}/messages/${message.id}/media`;const current=await request(route);assert.equal(current.status,200);assert.equal(current.body.files[0].fileId,saved.files[0].fileId);assert.equal(current.body.capabilities.extract,false);
 assert.equal((await request(route,'POST',{request_key:randomUUID(),goal:'extract'})).body.error,'media_adapter_unavailable');
 const preview=await request(`${route}/files/${saved.files[0].fileId}/preview`,'POST',{});assert.equal(preview.status,200);assert.equal(Buffer.from(preview.body.dataBase64,'base64').toString(),'synthetic-host-image');
 const deletion=request(route,'DELETE',undefined,{'idempotency-key':randomUUID()});
 for(let turn=0;turn<100;turn++){const status=await request(`/api/media/previews/${preview.body.sessionId}`);if(status.body.state==='revoking')break;}
 assert.equal((await request(`/api/media/previews/${preview.body.sessionId}`)).body.state,'revoking');await request(`/api/media/previews/${preview.body.sessionId}`,'DELETE');
 const cleared=await deletion;assert.equal(cleared.status,200);assert.equal(cleared.body.state,'cleared');assert.deepEqual(cleared.body.files,[]);assert.equal(cleared.body.cleanup,null);
 assert.equal((await request(`/api/contacts/${f.contact}/messages`)).body.messages.length,4);
 const account=await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'},{'idempotency-key':'synthetic-media-account'});assert.equal(account.status,202);const receipt=await request(`/api/deletions/${account.body.operation_id}`);assert.equal(receipt.body.state,'completed');
 assert.equal((await request('/api/runtime/shutdown','POST',{})).body.state,'stopped');assert.equal(await host.waitForExit(15000),true);
});
