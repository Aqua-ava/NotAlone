/** 合成公开请求经官方 profile 与真实回复服务；不预置 generation anchor。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {join} from 'node:path';
import pg from 'pg';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/platform/models/model-ledger.ts';
import {ReplyGenerationService} from '../src/reply/generation/reply-service.ts';
import {AssistantDiscussionService} from '../src/reply/discussion/assistant-discussion-service.ts';
import {AssistantGenerationLifecycle} from '../src/reply/discussion/assistant-generation-lifecycle.ts';
import {ExplorationService} from '../src/reply/exploration/exploration-service.ts';
import {withPublicReplyScope,resolveRequestBinding} from '../src/host/pure-ts-reply-scope.ts';
import {stringifyJson} from '../src/host/host-json.ts';
export const name='assistant-generation-lifecycle-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export function apply(ctx:Context){
 const database=process.env.NOTALONE_SYNTHETIC_DATABASE!;
 if(!/^notalone_pure_ts_[a-f0-9]+_test$/.test(database))throw Error('仅允许随机合成库');
 const transaction=async<T>(work:(client:pg.Client)=>Promise<T>)=>{const client=new pg.Client({host:'/tmp',database,user:process.env.NOTALONE_SYNTHETIC_DATABASE_USER});await client.connect();try{await client.query('BEGIN');try{const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}}finally{await client.end();}};
 const scope={owner_id:process.env.NOTALONE_SYNTHETIC_OWNER!,contact_id:process.env.NOTALONE_SYNTHETIC_CONTACT!,conversation_binding_id:process.env.NOTALONE_SYNTHETIC_BINDING!,confirmation:'manual' as const};
 const skillsRoot=join(process.env.HOME!,'skills');
 const provider=installModelProvider(ctx,{provider:'notalone-reply-guarded',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never});
 const serviceOptions={ctx,transaction,provider,arbiter:new ModelPermitArbiter(),ledger:new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()}),skillsRoot,model:{provider:'notalone-reply-guarded',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off' as const,physical_limit:4,deadline_ms:10000,warning_ratio:0.8,budgetProfile:{context_window_tokens:65536,safety_margin_tokens:128}}};
 const service=new ReplyGenerationService(serviceOptions),exploration=new ExplorationService(serviceOptions,true);
 const discussion=new AssistantDiscussionService({transaction,skillsRoot,resolveBinding:resolveRequestBinding});
 const lifecycleOptions={transaction,skillsRoot,replyService:service,resolveBinding:resolveRequestBinding,runInScope:withPublicReplyScope};
 let lifecycle=new AssistantGenerationLifecycle(lifecycleOptions);
 let gate:{entered:Promise<void>;enter:()=>void;wait:Promise<void>;release:()=>void}|undefined;
 const pause=ctx.on('llm/stream',async function*(options,next){if(gate&&options.provider?.startsWith('notalone-preflight-')){const current=gate;current.enter();await current.wait;gate=undefined;}yield* next();});
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');try{
  const url=new URL(req.url!,'http://localhost');let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
  if(url.pathname==='/arm-preflight'){let enter!:()=>void,release!:()=>void;gate={entered:new Promise<void>(r=>{enter=r;}),enter:()=>enter(),wait:new Promise<void>(r=>{release=r;}),release:()=>release()};res.end('{}');return;}
  if(url.pathname==='/wait-preflight'){await gate?.entered;res.end('{}');return;}
  if(url.pathname==='/release-preflight'){gate?.release();res.end('{}');return;}
  if(url.pathname==='/recreate-lifecycle'){await lifecycle.drain();lifecycle=new AssistantGenerationLifecycle(lifecycleOptions);await lifecycle.recover(scope.owner_id);res.end('{}');return;}
  const response=await withPublicReplyScope(scope,()=>lifecycle.handle({method:req.method!,path:url.pathname,body,scope,signal:new AbortController().signal,respondAsync:req.headers.prefer==='respond-async'}));
  if(response){res.statusCode=response.status;res.end(stringifyJson(response.payload));return;}
  if(typeof lifecycle.handleExploration==='function'){
   const explored=await withPublicReplyScope(scope,()=>lifecycle.handleExploration({method:req.method!,path:url.pathname,body,scope,signal:new AbortController().signal},exploration));
   if(explored){res.statusCode=explored.status;res.end(stringifyJson(explored.payload));return;}
  }
  const explore=url.pathname.match(/^\/api\/contacts\/([^/]+)\/assistant-sessions\/([^/]+)\/explorations$/);
  if(explore&&explore[1]===scope.contact_id){res.end(stringifyJson(await exploration.execute({owner_id:scope.owner_id,contact_id:scope.contact_id},explore[2],'open',body,new AbortController().signal,{manual_input:true})));return;}
  if(url.pathname===`/api/contacts/${scope.contact_id}/assistant-session/default`){res.end(stringifyJson({session_id:await discussion.defaultSession(scope)}));return;}
  const match=url.pathname.match(/^\/api\/contacts\/([^/]+)\/assistant-sessions\/([^/]+)$/);
  if(match&&match[1]===scope.contact_id){res.end(stringifyJson(await discussion.readSession(scope,match[2])));return;}
  res.statusCode=404;res.end('{"error":"not_found"}');
 }catch(error){res.statusCode=503;res.end(stringifyJson({error:error instanceof Error?error.message:'failed'}));}});
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);}));
 ctx.effect(()=>async()=>{ready();gate?.release();pause();await lifecycle.drain();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await provider.dispose();});
}
