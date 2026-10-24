/** 仅合成 PG 与 localhost 官方 runtime；scope 是测试预先认证的 domain 接缝。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {join} from 'node:path';
import pg from 'pg';
import {PostgresSkillPort} from '../src/skill-port.ts';
import {SkillFileError} from '../src/skill-files.ts';
import {ReplyGenerationService} from '../src/reply-service.ts';
import {installModelProvider} from '../src/model-provider.ts';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/model-ledger.ts';
import {createReplyHttp} from '../src/reply-http.ts';
import {stringifyJson} from '../src/host-json.ts';
export const name='notalone-reply-service-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export function apply(ctx:Context){
 const database=process.env.NOTALONE_SYNTHETIC_DATABASE!;
 if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database))throw Error('仅允许随机合成库');
 const transaction=async<T>(fn:(client:pg.Client)=>Promise<T>):Promise<T>=>{const client=new pg.Client({host:'/tmp',database,user:process.env.NOTALONE_SYNTHETIC_DATABASE_USER});await client.connect();try{await client.query('BEGIN');try{const value=await fn(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}}finally{await client.end();}};
 const provider=installModelProvider(ctx,{provider:'notalone-reply-guarded',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never});
 const arbiter=new ModelPermitArbiter(),ledger=new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()});
 const service=new ReplyGenerationService({ctx,transaction,provider,arbiter,ledger,skillsRoot:join(process.env.HOME!,'skills'),model:{provider:'notalone-reply-guarded',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',physical_limit:4,deadline_ms:10000,warning_ratio:0.8,budgetProfile:{context_window_tokens:65536,safety_margin_tokens:128}}});
 const replyOwner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER,replyToken=process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN;
 if(Boolean(replyOwner)!==Boolean(replyToken))throw Error('合成私有回复配置不完整');
 const replyHttp=replyOwner&&replyToken?createReplyHttp({ownerId:replyOwner,token:replyToken,read:transaction,service}):null;
 const originalResource=PostgresSkillPort.prototype.resource;let failResource=false,failBody=false;const originalLoad=PostgresSkillPort.prototype.loadVersion;
 PostgresSkillPort.prototype.loadVersion=async function(...args){const value=await originalLoad.apply(this,args);if(failBody){failBody=false;throw new SkillFileError();}return value;};
 PostgresSkillPort.prototype.resource=async function(...args){const value=await originalResource.apply(this,args);if(failResource){failResource=false;throw new SkillFileError();}return value;};
 const running=new Map<string,AbortController>();
 // 仅测试暂停真实预检stream；继续后仍执行原Adapter和全部生产守卫。
 let barrier:{entered:Promise<void>;enter:()=>void;released:Promise<void>;release:()=>void}|null=null;
 const preflightBodies:string[]=[];
 const pausePreflight=ctx.on('llm/stream',async function*(options,next){if(options.provider?.startsWith('notalone-preflight-'))preflightBodies.push(JSON.stringify(options));if(barrier&&options.provider?.startsWith('notalone-preflight-')){const current=barrier;current.enter();await current.released;barrier=null;}yield* next();});
 const server=createServer(async(req,res)=>{if(replyHttp&&await replyHttp.handle(req,res))return;res.setHeader('content-type','application/json');try{
  let raw='';for await(const part of req)raw+=part;const input=raw?JSON.parse(raw):{};
  if(req.url==='/skill-probes'){res.end(stringifyJson({preflightBodies}));return;}
  if(req.url==='/arm-body-fault'){failBody=true;res.end('{}');return;}
  if(req.url==='/arm-resource-fault'){failResource=true;res.end('{}');return;}
  if(req.url==='/health'){res.end(stringifyJson({permits:arbiter.snapshot()}));return;}
  if(req.url==='/arm-preflight'){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),released=new Promise<void>(r=>{release=r;});barrier={entered,enter,released,release};res.end('{}');return;}
  if(req.url==='/wait-preflight'){if(!barrier)throw Error('预检门未开启');await Promise.race([barrier.entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('真实预检未进入')),5000);timer.unref();})]);res.end('{}');return;}
  if(req.url==='/release-preflight'){barrier?.release();res.end('{}');return;}
  if(req.url==='/cancel'){running.get(input.id)?.abort(new Error('合成取消'));res.end('{}');return;}
  const controller=new AbortController();running.set(input.id,controller);
  try{const result=await (req.url==='/prepare'?service.prepare(input.scope,input.body,controller.signal):service.generate(input.scope,input.body,controller.signal));res.end(stringifyJson(result));}finally{running.delete(input.id);}
 }catch(error){res.statusCode=422;res.end(stringifyJson({error:error instanceof Error?error.message:'failed'}));}});
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${a.port}\n`);}));
 ctx.effect(()=>async()=>{ready();PostgresSkillPort.prototype.resource=originalResource;PostgresSkillPort.prototype.loadVersion=originalLoad;barrier?.release();pausePreflight();for(const c of running.values())c.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await provider.dispose();});
}
