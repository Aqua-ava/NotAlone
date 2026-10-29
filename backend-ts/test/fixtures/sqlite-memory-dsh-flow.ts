/** 官方 profile 的合成全链宿主：业务服务真实，仅替元数据、微信和环回供应商。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {createServer,type Server} from 'node:http';
import {fixture,owner,record} from './memory-sqlite/support.mjs';
import {resolveHostReplyConfiguration} from '../../src/host/host-reply-config.ts';
import {startModelHost} from '../../src/platform/models/model-host.ts';
import {createSqliteExtractionModelPort} from '../../src/memory/sqlite/model-port.ts';
import {SqliteMemoryExtraction} from '../../src/memory/sqlite/service.ts';
import {SqliteMemoryExtractionHttp} from '../../src/memory/sqlite/http.ts';
import {authorizeSqliteRequest} from '../../src/sqlite-host-plugin.ts';
import {join} from 'node:path';

export const name='sqlite-memory-dsh-flow-synthetic';
export const inject=['llm','appReady','appExit'];
export async function apply(ctx:Context) {
 const cleanups:Array<()=>Promise<void>>=[];
 let memory:SqliteMemoryExtraction|undefined,host:Awaited<ReturnType<typeof startModelHost>>|undefined,server:Server|undefined;
 let setup:Awaited<ReturnType<typeof fixture>>|undefined,cancelReady=()=>{},closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  cancelReady();
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  try {if(host)await host.close(async()=>{await memory?.close();});else await memory?.close();}
  finally {
   if(setup){await setup.service.close();await setup.contacts.close();}
   for(const cleanup of cleanups.reverse())await cleanup();
  }
 })();
 ctx.effect(()=>close,'sqlite-memory-dsh-flow-resources');
 setup=await fixture({after:(cleanup:()=>Promise<void>)=>cleanups.push(cleanup)});
 const f=setup!;
 const providerURL=process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!;
 const targetURL=new URL(providerURL);
 if(targetURL.protocol!=='http:'||targetURL.hostname!=='127.0.0.1'||targetURL.username||targetURL.password)throw new Error('synthetic_provider_loopback_required');
 const configuration=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
 if(configuration.status!=='configured')throw new Error('synthetic_configuration_unavailable');
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:f.root},businessHome:f.root,
  infoPath:join(f.root,'info'),envFilePath:join(f.root,'env'),accounting:{
   reserve:async(receipt,claim)=>{if(!memory)throw new Error('synthetic_not_ready');await memory.accounting.reserve(receipt,claim);},
   recordReserved:async receipt=>{if(!memory)throw new Error('synthetic_not_ready');await memory.accounting.recordReserved(receipt);},
   unconfirmedRequests:scope=>{if(!memory)throw new Error('synthetic_not_ready');return memory.accounting.unconfirmedRequests!(scope);},
  }});
 // 正常模型、预算、期限不覆盖；认证仍由正常配置解析器提供，只替换实际网络目的地。
 const loopbackConfiguration={...configuration,provider:{...configuration.provider,connection:{...configuration.provider.connection,baseURL:providerURL},
  resolveAuth:()=>configuration.provider.resolveAuth(configuration.provider.connection)}};
 const createMemory=()=>{
 const model=createSqliteExtractionModelPort({ctx,configuration:loopbackConfiguration,permit:host!.permit,
  resolveUserId:()=> 'synthetic-anonymous' as never,authorizePurpose:async input=>{
   if(input.scope.owner_id!==owner||!f.saved.some((binding:{contact_id:string})=>binding.contact_id===input.scope.contact_id))throw new Error('synthetic_purpose_denied');
  }});
 return new SqliteMemoryExtraction(f.storage,owner,model);
 };
 memory=createMemory();
 f.channel.page=async(scope:any)=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:[record('1',{text:scope.token.contact_id===f.saved[0].contact_id?'合成甲的已保存文字。':'合成乙的已保存文字。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const binding of f.saved)await f.service.synchronize(binding.contact_id);
 await f.contacts.setReading(false);
 // 记忆处理不具备补读能力；已保存后若访问微信，合成端口立即报错。
 f.channel.page=async()=>{throw new Error('synthetic_reading_disabled');};
 const token=process.env.NOTALONE_SYNTHETIC_HTTP_TOKEN!;
 const authorize=(req:Parameters<typeof authorizeSqliteRequest>[0])=>authorizeSqliteRequest(req,token);
 let http=new SqliteMemoryExtractionHttp(memory,authorize);
 server=createServer(async(req,res)=>{
  try {
   if(req.url?.startsWith('/__fixture/')){
    if(!authorize(req)){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'unauthorized'}));return;}
    if(req.url==='/__fixture/wait'&&req.method==='POST'){
     await memory!.waitForIdle();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({idle:true,integrity:await f.storage.check(),
      normalModel:configuration.model,readingEnabled:false}));return;
    }
    if(req.url==='/__fixture/add-message'&&req.method==='POST'){
     await f.contacts.setReading(true);
     f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'合成甲的后到文字。'})],completedPartitions:['shard-a'],exhausted:true});
     await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
     f.channel.page=async()=>{throw new Error('synthetic_reading_disabled');};
     res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({saved:true}));return;
    }
    if(req.url==='/__fixture/restart-model'&&req.method==='POST'){
     await memory!.close();memory=createMemory();http=new SqliteMemoryExtractionHttp(memory,authorize);
     res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({restarted:true}));return;
    }
    if(req.url==='/__fixture/stop'&&req.method==='POST'){
     res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({stopping:true}));ctx.appExit!(0);return;
    }
   }
   if(await http.handle(req,res))return;
   res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'not_found'}));
  }catch {res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic_fixture_failed'}));}
 });
 cancelReady=ctx.appReady!.onReady(()=>server!.listen(0,'127.0.0.1',()=>{
  const address=server!.address();if(address&&typeof address!=='string')process.stdout.write(`SQLITE_MEMORY_DSH_READY ${JSON.stringify({url:`http://127.0.0.1:${address.port}`,businessRoot:f.root,contactIds:f.saved.map((binding:{contact_id:string})=>binding.contact_id)})}\n`);
 }));
}
