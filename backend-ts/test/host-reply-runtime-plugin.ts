/** 合成数据经过官方profile和真实宿主回复装配；控制端点仅存在于此测试插件。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../src/host-storage.ts';
import {createHostReplyRuntime} from '../src/host-reply.ts';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/model-ledger.ts';
import {stringifyJson} from '../src/host-json.ts';
import {randomBytes} from 'node:crypto';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {SourceProcessingTraceStore} from '../src/source-processing-trace.ts';
export const name='notalone-host-reply-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  const database=process.env.NOTALONE_SYNTHETIC_DATABASE!,owner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database)||!owner)throw Error('仅允许随机合成库及指定合成本人');
  const home=process.env.HOME!,envFilePath=join(home,'synthetic.env'),skillsRoot=join(home,'skills');
  await mkdir(skillsRoot,{mode:0o700});
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../backend/database/migrations',import.meta.url).pathname,environment:{HOME:home}});
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
      provider:'notalone-host-reply-test',
      model:'deepseek-flash',
      unconfirmedPermitIds:()=>permitServer?.unconfirmedPermitIds()??[],
    });
    permitServer=await startModelPermitServer({path:join(home,'l2-permit.sock'),token:l2Token,arbiter,accounting});
  }
  const runtime=await createHostReplyRuntime({ctx,storage,arbiter,ledger,token:process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN!,
    ...(extractionEnabled?{extractionEnabled:true,extractionAdoptionEnabled:true}:{}),
    ...(traceStore?{sourceTraces:traceStore}:{}),
    ...(permitServer?{extractionPermit:{path:join(home,'l2-permit.sock'),token:l2Token}}:{}),
    configuration:{skillsRoot,
    provider:{provider:'notalone-host-reply-test',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never},
    model:{provider:'notalone-host-reply-test',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',physical_limit:2,deadline_ms:10000,warning_ratio:0.8,budgetProfile:{context_window_tokens:65536,safety_margin_tokens:128}}}});
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'','http://localhost');
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
