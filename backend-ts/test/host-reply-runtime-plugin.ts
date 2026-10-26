/** 合成数据经过官方profile和真实宿主回复装配；控制端点仅存在于此测试插件。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {createHostReplyRuntime} from '../src/host/host-reply.ts';
import {SkillFiles} from '../src/skills/skill-files.ts';
import {SkillLibrary} from '../src/skills/skill-library.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/platform/models/model-ledger.ts';
import {stringifyJson} from '../src/host/host-json.ts';
import {randomBytes} from 'node:crypto';
import {createHostModelAccounting} from '../src/host/host-model-accounting.ts';
import {startModelPermitServer} from '../src/platform/models/model-permit-server.ts';
import {SourceProcessingTraceStore} from '../src/diagnostics/source-processing-trace.ts';
import {skillLearningRoute} from '../src/skills/skill-learning-http.ts';
import pg from 'pg';
import {appendFileSync} from 'node:fs';
export const name='notalone-host-reply-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  const database=process.env.NOTALONE_SYNTHETIC_DATABASE!,owner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database)||!owner)throw Error('仅允许随机合成库及指定合成本人');
  // 观测真实PG返回的数据量；不替换查询、结果或生产守卫，不记录合成正文。
  const sqlLog=process.env.NOTALONE_SYNTHETIC_SQL_RESULT_LOG,marker=process.env.NOTALONE_SYNTHETIC_SQL_MARKER;
  if(sqlLog&&marker){
    const query=pg.Client.prototype.query;
    pg.Client.prototype.query=function(...args:any[]){
      const result=(query as any).apply(this,args);
      if(!result?.then)return result;
      return result.then((value:any)=>{
        const rows=value.rows??[],raw=JSON.stringify(rows),bytes=rows.reduce((n:number,row:any)=>n+Object.values(row).filter(v=>JSON.stringify(v)?.includes(marker)).reduce((m:number,v)=>m+Buffer.byteLength(JSON.stringify(v)),0),0);
        appendFileSync(sqlLog,JSON.stringify({sql:typeof args[0]==='string'?args[0]:args[0]?.text,rows:rows.length,result_bytes:Buffer.byteLength(raw),marker_bytes:bytes})+'\n',{mode:0o600});return value;
      }).catch((error:any)=>{process.stderr.write('SQL_RESULT_ERROR '+error.message+'\n');throw error;});
    } as typeof query;
  }
  const home=process.env.NOTALONE_SYNTHETIC_BUSINESS_HOME??process.env.HOME!,envFilePath=join(home,'synthetic.env'),skillsRoot=join(home,'skills');
  await mkdir(skillsRoot,{mode:0o700,recursive:true});
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../database/migrations',import.meta.url).pathname,environment:{HOME:home}});
  let skillLibrary:SkillLibrary|undefined;
  if(process.env.NOTALONE_SYNTHETIC_SKILL_PACKAGE){
    skillLibrary=new SkillLibrary(storage,new SkillFiles(skillsRoot));
    await skillLibrary.importPackage(owner,process.env.NOTALONE_SYNTHETIC_SKILL_PACKAGE);
  }
  const arbiter=new ModelPermitArbiter();
  const ledger=new PostgresModelLedger({transaction:work=>storage.businessTransaction(work),details:new PostgresModelLedgerDetails()});
  const l2Enabled=process.env.NOTALONE_SYNTHETIC_L2==='1';
  const extractionEnabled=l2Enabled&&process.env.NOTALONE_SYNTHETIC_EXTRACTION==='1';
  const l2Pool=l2Enabled?await storage.businessPool():undefined;
  const traceStore=l2Pool?new SourceProcessingTraceStore(l2Pool):undefined;
  const l2Token=`synthetic-l2-permit-${randomBytes(24).toString('hex')}`;
  let permitServer:Awaited<ReturnType<typeof startModelPermitServer>>|undefined;
  let l2Closing:Promise<void>|undefined;
  const closeL2=()=>l2Closing??=(async()=>{await permitServer?.shutdown();await l2Pool?.end();})();
  if(l2Enabled){
    const accounting=createHostModelAccounting({
      transaction:work=>storage.businessTransaction(work),
      provider:'deepseek',
      typescriptProvider:'notalone-host-reply-test',
      model:'deepseek-flash',
      unconfirmedPermitIds:()=>permitServer?.unconfirmedPermitIds()??[],
    });
    permitServer=await startModelPermitServer({path:join(home,'l2-permit.sock'),token:l2Token,arbiter,accounting});
  }
  const runtime=await createHostReplyRuntime({ctx,storage,arbiter,ledger,token:process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN!,
    ...(process.env.NOTALONE_SYNTHETIC_ASSISTANT_CLOCK?{assistantClock:()=>readFile(process.env.NOTALONE_SYNTHETIC_ASSISTANT_CLOCK!,'utf8')}:{ }),
    ...(skillLibrary?{skillLibrary}:{}),
    ...(process.env.NOTALONE_SYNTHETIC_PERSISTENT==='1'?{publicRuntime:true,persistentAssistantHome:home}:process.env.NOTALONE_SYNTHETIC_PUBLIC==='1'?{publicRuntime:true}:{}),
    ...(extractionEnabled?{extractionEnabled:true,extractionAdoptionEnabled:true}:{}),
    ...(traceStore?{sourceTraces:traceStore}:{}),
    ...(permitServer?{extractionPermit:{path:join(home,'l2-permit.sock'),token:l2Token}}:{}),
    configuration:{skillsRoot,
    provider:{provider:'notalone-host-reply-test',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never},
    model:{provider:'notalone-host-reply-test',model:'deepseek-flash',maxTokens:256,temperature:Number(process.env.NOTALONE_SYNTHETIC_REPLY_TEMPERATURE??'0'),reasoningEffort:'off',physical_limit:2,deadline_ms:10000,warning_ratio:0.8,budgetProfile:{context_window_tokens:65536,safety_margin_tokens:128}}}});
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'','http://localhost');
    if(/^\/api\/skills\/[^/]+\/(enable|disable)$/.test(url.pathname)&&req.method==='POST'){
      if(req.headers.authorization!==`Bearer ${process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN}`){res.writeHead(401).end('{}');return;}
      for await(const _part of req){};
      try{skillLibrary??=new SkillLibrary(storage,new SkillFiles(skillsRoot));const result=await skillLibrary.handle('POST',url,{});res.writeHead(200,{'content-type':'application/json'}).end(stringifyJson(result));}catch(error){res.writeHead((error as {status?:number}).status??503).end('{}');}return;
    }
    if(skillLearningRoute(req.method??'',url.pathname)){
      if(req.headers.authorization!==`Bearer ${process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN}`){
        res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"unauthorized"}');return;
      }
      let body:unknown,raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>256*1024){res.writeHead(413);res.end('{}');return;}}
      if(req.method==='POST'){try{body=JSON.parse(raw);}catch{res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"skill_learning_request_invalid"}');return;}}
      const controller=new AbortController(),abort=()=>controller.abort();
      req.once('aborted',abort);res.once('close',abort);
      try{
        const result=await runtime.handleSkillLearning(req.method??'',url,body,controller.signal);
        if(!res.destroyed){res.writeHead(result.status,{'content-type':'application/json'});res.end(stringifyJson(result.body));}
      }catch(error){
        if(!res.destroyed){
          const value=error as {status?:unknown;code?:unknown};
          res.writeHead(typeof value.status==='number'?value.status:503,{'content-type':'application/json'});
          res.end(stringifyJson({error:typeof value.code==='string'?value.code:'skill_learning_unavailable'}));
        }
      }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
      return;
    }
    if(url.pathname.startsWith('/api/memories/owner/layered-memory')||/^\/api\/contacts\/[^/]+\/layered-memory/.test(url.pathname)){
      if(req.headers.authorization!==`Bearer ${process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN}`){
        res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"unauthorized"}');return;
      }
      const layered=await runtime.handleLayeredMemory(req,res,url);
      if(layered.handled)return;
      if(layered.replayBody){
        res.writeHead(202,{'content-type':'application/json'});res.end(stringifyJson({replayed:true}));return;
      }
    }
    if((process.env.NOTALONE_SYNTHETIC_PERSISTENT==='1'||process.env.NOTALONE_SYNTHETIC_PUBLIC==='1')&&url.pathname.startsWith('/api/')){
      if(req.headers.authorization!==`Bearer ${process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN}`){res.writeHead(401);res.end('{}');return;}
      if(await runtime.handlePublic(req,res,url))return;
    }
    if(await runtime.handle(req,res))return;
    if(req.method==='POST'&&req.url==='/close-reply'){
      runtime.stopAccepting();await Promise.all([runtime.close(),runtime.close()]);
      await closeL2();
      res.setHeader('content-type','application/json');res.end(stringifyJson({closed:true,permits:arbiter.snapshot()}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);}));
  ctx.effect(()=>async()=>{
    ready();runtime.stopAccepting();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await runtime.close();await closeL2();await storage.close();
  });
}
