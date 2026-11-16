/** 官方 DSH 合成链路：图片补取、冻结输入、正式调度及真实环回模型传输。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mock} from 'node:test';
import {join} from 'node:path';
import sharp from 'sharp';
import {fixture} from '../media-support.mjs';
import {SqliteImageSyncCoordinator} from '../../src/media/sqlite/image-sync.ts';
import {StorageFailure} from '../../src/storage/sqlite/contracts.ts';
import type {MediaAdapter} from '../../src/media/sqlite/contracts.ts';
import {createBuiltinMemoryContentRegistry} from '../../src/memory/content/builtins.ts';
import {createSqliteMemoryRuntime} from '../../src/memory/sqlite/runtime.ts';
import {resolveHostReplyConfiguration} from '../../src/host/host-reply-config.ts';
import {startModelHost} from '../../src/platform/models/model-host.ts';
import {installModelProvider} from '../../src/platform/models/model-provider.ts';
import {authorizeSqliteRequest} from '../../src/sqlite-host-plugin.ts';
import type {ModelLedgerReceipt} from '../../src/platform/models/model-ledger-contract.ts';

export const name='sqlite-memory-late-image-flow-synthetic';
export const inject=['llm','appReady','appExit'];
export async function apply(ctx:Context) {
 const endpoint=new URL(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!);
 const token=process.env.NOTALONE_SYNTHETIC_HTTP_TOKEN;
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||!token)throw new Error('synthetic_loopback_and_token_required');
 const realSetTimeout=setTimeout,realClearTimeout=clearTimeout,cleanups:Array<()=>Promise<void>>=[];
 let runtime:Awaited<ReturnType<typeof createSqliteMemoryRuntime>>|undefined,host:Awaited<ReturnType<typeof startModelHost>>|undefined;
 let provider:ReturnType<typeof installModelProvider>|undefined,sync:SqliteImageSyncCoordinator|undefined,server:Server|undefined;
 let cancelReady=()=>{},closing:Promise<void>|undefined,ready=false,started=false,minimumRuns=1,scanCount=0;
 const receipts:ModelLedgerReceipt[]=[],runIds=new Set<string>(),listeners=new Set<()=>void>();
 const notify=()=>{for(const listener of [...listeners])listener();};
 const until=(predicate:()=>boolean)=>predicate()?Promise.resolve():new Promise<void>((resolve,reject)=>{
  const timer=realSetTimeout(()=>{listeners.delete(check);reject(new Error('synthetic_wait_timeout'));},15_000);
  const check=()=>{if(predicate()){realClearTimeout(timer);listeners.delete(check);resolve();}};listeners.add(check);check();
 });
 const close=()=>closing??=(async()=>{
  cancelReady();mock.timers.reset();
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  try{await sync?.close();if(host)await host.close(async()=>{await runtime?.close();});else await runtime?.close();}
  finally{await provider?.dispose();for(const cleanup of cleanups.reverse())await cleanup();}
 })();
 ctx.effect(()=>close,'sqlite-late-image-flow-resources');
 mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const images=await Promise.all([{width:16,height:12,background:'blue'},{width:20,height:14,background:'red'}].map(async dimensions=>{
  const bytes=await sharp({create:{...dimensions,channels:3}}).png().toBuffer();return {...dimensions,bytes,pngSha256:createHash('sha256').update(bytes).digest('hex')};
 }));
 const byMessage=new Map<string,(typeof images)[number]>(),reads=new Map<string,number>();
 const adapter:MediaAdapter={version:'synthetic-late-image-flow-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(input){
  reads.set(input.messageId,(reads.get(input.messageId)??0)+1);
  if(!ready)throw new StorageFailure('media_thumbnail_only');
  const image=byMessage.get(input.messageId);if(!image)throw new Error('synthetic_image_not_registered');
  await input.save({role:'image_display',bytes:(async function*(){yield image.bytes;})(),expectedBytes:image.bytes.length,expectedSha256:image.pngSha256,
   validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-late-image-flow-v1',recordId:input.source!.recordId,messageId:input.messageId,resourceIdentity:'synthetic-late-image-'+input.messageId}};
 }};
 const f=await fixture({after:(cleanup:()=>Promise<void>)=>cleanups.push(cleanup)},adapter,{onMediaChanged:(contactId:string)=>runtime?.wake(contactId)});
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[{partition:'a',table:'one',localId:'5',serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const imageMessages=(await f.history.read(f.contact)).messages.filter((message:{kind:string})=>message.kind==='image');
 if(imageMessages.length!==2)throw new Error('synthetic_two_images_required');
 const imageIds=imageMessages.map((message:{id:string},index:number)=>{byMessage.set(message.id,images[index]!);return message.id;});
 // 仅观察公开存储动作的实际结果，让等待跟随正式调度；不替换其资格、输入或返回值。
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(action:string,input:unknown,...rest:unknown[])=>{
  const value=await execute(action,input,...rest);
  if(action==='memoryExtraction.scanSchedule')scanCount++;
  if(['memoryExtraction.startHistoryBatch','memoryExtraction.startContact'].includes(action)&&value?.runId)runIds.add(value.runId);
  notify();return value;
 };
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'},{purpose:'memory'});
 if(configuration.status!=='configured')throw new Error('synthetic_configuration_unavailable');
 // 时间前进一分钟用于补取；只延长合成连接的流空闲，保留正常模型、能力与调用预算。
 const loopback={...configuration,provider:{...configuration.provider,connection:{...configuration.provider.connection,baseURL:endpoint.href,streamIdleTimeoutMs:120_000},
  strictVerificationEndpoint:new URL('/beta/chat/completions',endpoint).href,resolveAuth:()=>configuration.provider.resolveAuth(configuration.provider.connection)}};
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:f.root},businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'env'),accounting:{
  reserve:async(receipt,claim)=>{if(!runtime)throw new Error('synthetic_runtime_not_ready');await runtime.service.accounting.reserve(receipt,claim);},
  recordReserved:async receipt=>{if(!runtime)throw new Error('synthetic_runtime_not_ready');await runtime.service.accounting.recordReserved(receipt);receipts.push(structuredClone(receipt));},
  unconfirmedRequests:scope=>{if(!runtime)throw new Error('synthetic_runtime_not_ready');return runtime.service.accounting.unconfirmedRequests!(scope);},
 }});
 provider=installModelProvider(ctx,{...loopback.provider,resolveUserId:()=> 'synthetic-anonymous' as never});
 runtime=await createSqliteMemoryRuntime({ctx,storage:f.storage,ownerId:f.owner,userData:f.root,businessHome:f.root,infoPath:join(f.root,'memory.info'),envFilePath:join(f.root,'unused.env'),environment:{},
  holders:f.media.holders,authorize:()=>false,adjudicationEnabled:true,contentRegistry:createBuiltinMemoryContentRegistry(),contentResources:{readImage:input=>f.media.readMemoryImage(input)},
  sharedModel:{configuration:loopback,provider,permit:host.permit,resolveUserId:()=> 'synthetic-anonymous' as never}});
 sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);
 const state=async()=>{
  const runs=await Promise.all([...runIds].map(id=>runtime!.service.read(id))),traces=[];
  for(const run of runs)for(const task of run.tasks)traces.push(await runtime!.service.trace(task.taskId));
  const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
  let processing,followups;try{processing=imageIds.map((messageId:string)=>db.prepare("SELECT id,extraction_state,pipeline_state FROM processing_item WHERE owner_id=? AND contact_id=? AND message_id=? AND purpose='memory_extraction'").get(f.owner,f.contact,messageId)??null);
   followups=db.prepare('SELECT run_id AS runId,outcome,reason FROM memory_document_later_run_requirement WHERE owner_id=? AND contact_id=? ORDER BY updated_at,run_id').all(f.owner,f.contact);
  }finally{db.close();}
  return {automatic:runtime!.service.automaticEnabled,contact:await runtime!.service.readContact(f.contact),later:await runtime!.documents!.queueSummary(),followups,runs,traces,images:await Promise.all(imageIds.map(async(messageId:string,index:number)=>({messageId,media:await f.media.read(f.contact,messageId),processing:processing[index],reads:reads.get(messageId)??0}))),
   receipts:receipts.map(receipt=>({attempt_id:receipt.attempt_id,request_id:receipt.request_id,dispatch:receipt.dispatch,outcome:receipt.outcome,input_budget:receipt.input_budget}))};
 };
 server=createServer(async(req,res)=>{
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
   if(!req.url?.startsWith('/__fixture/')||!authorizeSqliteRequest(req,token)){reply(401,{error:'unauthorized'});return;}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
   if(req.url==='/__fixture/state'&&req.method==='GET'){reply(200,await state());return;}
   if(req.method!=='POST'){reply(405,{error:'method_not_allowed'});return;}
   if(req.url==='/__fixture/start'){started=true;runtime!.startScheduling();reply(200,{started:true});return;}
   if(req.url==='/__fixture/retry-images'){sync!.wake(f.contact);await sync!.waitForIdle();sync!.retryViewed(f.contact,imageIds);await sync!.waitForIdle();reply(200,await state());return;}
   if(req.url==='/__fixture/images-ready'){if(!ready){minimumRuns=runIds.size+1;ready=true;}mock.timers.tick(60_000);await sync!.waitForIdle();reply(200,await state());return;}
   if(req.url==='/__fixture/automatic'){if(typeof body.enabled!=='boolean')throw new Error('synthetic_switch_invalid');reply(200,await runtime!.service.setAutomatic(body.enabled));return;}
   if(req.url==='/__fixture/wake'){sync!.wake(f.contact);await sync!.waitForIdle();runtime!.wake(f.contact);reply(200,{woken:true});return;}
   if(req.url==='/__fixture/wait'){
    if(started&&runtime!.service.automaticEnabled){const previous=scanCount;runtime!.wake(f.contact);await until(()=>scanCount>previous);await until(()=>runIds.size>=(body.minimumRuns??minimumRuns));await runtime!.service.waitForIdle();}
    reply(200,{idle:true,...await state()});return;
   }
   if(req.url==='/__fixture/stop'){reply(200,{stopping:true});ctx.appExit!(0);return;}
   reply(404,{error:'not_found'});
  }catch(error){reply(500,{error:error instanceof StorageFailure?error.code:error instanceof Error?error.message:'synthetic_fixture_failed'});}
 });
 cancelReady=ctx.appReady!.onReady(()=>server!.listen(0,'127.0.0.1',()=>{
  const address=server!.address();if(address&&typeof address!=='string')process.stdout.write(`SQLITE_LATE_IMAGE_READY ${JSON.stringify({url:`http://127.0.0.1:${address.port}`,contactId:f.contact,imageMessageIds:imageIds,images:imageIds.map((messageId:string,index:number)=>({messageId,pngSha256:images[index]!.pngSha256,width:images[index]!.width,height:images[index]!.height}))})}\n`);
 }));
}
