import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {SqliteStorage} from '../../backend-ts/src/storage/sqlite/client.ts';
import {ActiveHolders} from '../../backend-ts/src/storage/sqlite/deletion/holders.ts';
import {SqliteContactService} from '../../backend-ts/src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../../backend-ts/src/reply/sqlite/service.ts';
import {createAssistantReadChannel} from '../../backend-ts/src/reply/sqlite/read-channel.ts';
import {SqliteDiscussionHttp} from '../../backend-ts/src/reply/sqlite/http.ts';

// 复用真实受理、取消终态、独立只读 Worker 和 HTTP；不装配模型或桌面 App。
const repo=fileURLToPath(new URL('../../',import.meta.url));
const {build}=createRequire(join(repo,'desktop/package.json'))('esbuild');
const output=await build({stdin:{contents:"export {readAssistantSession} from './src/main/reply/assistant-sessions';export {JsonClient} from './src/main/backend/json-client';",resolveDir:join(repo,'desktop')},bundle:true,platform:'node',format:'esm',write:false});
const {readAssistantSession,JsonClient}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const ownerId='00000000-0000-4000-8000-000000000001',limit=8_388_608;
const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-read-proof-')));
let storage,reader,server,identity,client;
try{
 storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 identity=new SqliteContactService(storage,ownerId,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>[{externalKey:'a',displayName:'合成联系人',kind:'private',identityAssurance:'verified'}]});
 await identity.initialize();await identity.confirmAccount((await identity.detectAccount()).candidate_token);
 const snapshot=await identity.candidates(true);
 await identity.confirm(snapshot.snapshot_token,[{locator:'a',observed_display_name:'合成联系人',expected_selection_generation:'0'}]);
 const contactId=(await identity.directory()).contacts[0].contact_id;
 reader=await createAssistantReadChannel({storage,ownerId,holders:new ActiveHolders()});
 const service=new SqliteDiscussionService(storage,ownerId,()=>1_000_000,reader);
 const sessionId=(await service.newDiscussion(contactId)).id;
 async function append(text){
  const requestKey=randomUUID();
  const confirmationId=await storage.execute('identity.manualConfirm',{ownerId,contactId,contextToken:requestKey,id:randomUUID(),at:1_000_000});
  const accepted=await service.begin(contactId,requestKey,text,{kind:'manual',confirmationId},sessionId);
  await storage.execute('discussion.cancel',{...accepted.attempt,at:1_000_000});
 }
 const project=view=>({mode:'sqlite',session_id:sessionId,entries:view.entries.map(e=>({entry_id:e.id,position:String(e.position),role:e.role,text:e.content_state==='cleared'?null:e.body,request_id:e.origin_request_id,call_id:e.content_state==='cleared'?null:e.origin_call_id,content_state:e.content_state})),runtime_recovery:'none'});
 for(let index=0;index<27;index++)await append('合'.repeat(100_000));
 const before=await service.view(contactId,sessionId),beforeBytes=Buffer.byteLength(JSON.stringify(project(before)));
 // UUID 固定宽度；预先计算第 28 条的信封，再填满剩余 UTF-8 预算。
 const hypothetical=project(before);
 hypothetical.entries.push({entry_id:randomUUID(),position:'28',role:'user',text:'',request_id:randomUUID(),call_id:null,content_state:'available'});
 const remaining=limit-Buffer.byteLength(JSON.stringify(hypothetical));
 const lastText='合'.repeat(Math.floor(remaining/3))+'a'.repeat(remaining%3);
 assert.ok(lastText.length>0&&lastText.length<=100_000);
 await append(lastText);
 const boundary=await service.view(contactId,sessionId),boundaryBytes=Buffer.byteLength(JSON.stringify(project(boundary)));
 assert.equal(boundary.entries.length,28);assert.equal(boundaryBytes,limit);
 const http=new SqliteDiscussionHttp(service,req=>req.headers.authorization==='Bearer synthetic');
 let requests=0;
 server=createServer(async(req,res)=>{requests++;if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 client=new JsonClient({address:'127.0.0.1',port:server.address().port,token:'synthetic',pid:process.pid});
 const backend={getConnectionGeneration:()=>1,requestJson:async options=>({...await client.perform(options),generation:1})};
 const saved=await readAssistantSession(backend,contactId,sessionId,new AbortController().signal);
 assert.equal(saved.discussionEntries.length,28);assert.equal(saved.discussionEntries[27].text,lastText);
 const acceptedRequests=requests;
 await append('超');
 const excess=await service.view(contactId,sessionId),excessBytes=Buffer.byteLength(JSON.stringify(project(excess)));
 assert.ok(excessBytes>limit);assert.equal(excess.entries.length,29);
 await assert.rejects(readAssistantSession(backend,contactId,sessionId,new AbortController().signal),error=>error.code==='response_too_large');
 assert.equal(requests-acceptedRequests,1);
 console.log(JSON.stringify({node:process.version,entryCharacterLimit:100_000,nearBytes:beforeBytes,boundaryBytes,boundaryEntries:boundary.entries.length,boundaryRequests:acceptedRequests,boundaryLastEntryCharacters:lastText.length,excessBytes,excessEntries:excess.entries.length,excessRequests:requests-acceptedRequests,excessResult:'response_too_large',worker:'通过',modelCalls:0}));
}finally{
 client?.cancelPending();
 if(server)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 await identity?.close();await reader?.close();await storage?.close();
 await rm(root,{recursive:true,force:true});
}
