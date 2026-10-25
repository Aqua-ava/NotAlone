/** 仅合成评测的官方 profile 装配；全部业务能力复用公开 TS 服务。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../../../backend-ts/src/host-storage.ts';
import {createHostReplyRuntime} from '../../../backend-ts/src/host-reply.ts';
import {ModelPermitArbiter} from '../../../backend-ts/src/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../../../backend-ts/src/model-ledger.ts';
import {createHostModelAccounting} from '../../../backend-ts/src/host-model-accounting.ts';
import {startModelPermitServer} from '../../../backend-ts/src/model-permit-server.ts';
import {SourceProcessingTraceStore} from '../../../backend-ts/src/source-processing-trace.ts';
import {createL2ScenarioSourceValidator} from '../../../backend-ts/src/l2-scenario-source-validation.ts';
import {createL2ScenarioHost} from '../../../backend-ts/src/l2-scenario-host.ts';
import {L2ScenarioConflict} from '../../../backend-ts/src/l2-scenario-service.ts';
import {L2ScenarioError} from '../../../backend-ts/src/l2-scenario-workspace.ts';
import {createLayeredMemoryManagement} from '../../../backend-ts/src/layered-memory-management.ts';
import {installModelProvider} from '../../../backend-ts/src/model-provider.ts';
import {SkillLearningStore} from '../../../backend-ts/src/skill-learning-store.ts';
import {SkillFiles} from '../../../backend-ts/src/skill-files.ts';
import {ExtractionTaskStore} from '../../../backend-ts/src/extraction-task-store.ts';
import {stringifyJson} from '../../../backend-ts/src/host-json.ts';
export const name='notalone-nonreply-formal-synthetic';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  if(process.env.NOTALONE_HOST_RUNTIME!=='typescript')throw Error('typescript_runtime_required');
  const database=process.env.NOTALONE_SYNTHETIC_DATABASE!,owner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database)||!owner)throw Error('synthetic_database_required');
  const home=process.env.HOME!,envFilePath=join(home,'synthetic.env');
  const skillsRoot=process.env.NOTALONE_FORMAL_SKILLS_DIR||join(home,'skills');await mkdir(skillsRoot,{mode:0o700,recursive:true});
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../../backend/database/migrations',import.meta.url).pathname,environment:{HOME:home}});
  const pool=await storage.businessPool(),traces=new SourceProcessingTraceStore(pool),arbiter=new ModelPermitArbiter();
  const ledger=new PostgresModelLedger({transaction:work=>storage.businessTransaction(work),details:new PostgresModelLedgerDetails()});
  const token=`synthetic-formal-${randomBytes(24).toString('hex')}`;
  let permits:Awaited<ReturnType<typeof startModelPermitServer>>;
  const accounting=createHostModelAccounting({transaction:work=>storage.businessTransaction(work),provider:'deepseek',
    typescriptProvider:'notalone-host-reply-test',model:'deepseek-flash',unconfirmedPermitIds:()=>permits?.unconfirmedPermitIds()??[]});
  permits=await startModelPermitServer({path:join(home,'l2-permit.sock'),token,arbiter,accounting});
  const endpoint={path:join(home,'l2-permit.sock'),token};
  const providerConfiguration={provider:'notalone-host-reply-test',
    strictVerificationEndpoint:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!+'/v1/messages',
    connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:4096,retryPolicy:{mode:'normal',maxRetries:0}}),
    resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never};
  const binding={provider:'notalone-host-reply-test',model:'deepseek-flash',maxTokens:4096,temperature:0,reasoningEffort:'off' as const};
  const profile={context_window_tokens:128000,safety_margin_tokens:128};
  const domain=process.env.NOTALONE_FORMAL_DOMAIN!,asOf=new Date(process.env.NOTALONE_FORMAL_AS_OF!);
  const transaction=async<T>(work:(client:any)=>Promise<T>):Promise<T>=>{
    let businessFailure:unknown;
    try{return await storage.businessTransaction(async client=>{
      try{return await work(client);}catch(error){
        process.stderr.write('SYNTHETIC_TRANSACTION_ERROR '+JSON.stringify({code:(error as any).code,
          message:(error as any).message,stack:(error as any).stack})+'\n');
        if(error instanceof L2ScenarioConflict||error instanceof L2ScenarioError)businessFailure=error;
        throw error;
      }
    });}catch(error){throw businessFailure??error;}
  };
  const layered=domain.startsWith('l')?createL2ScenarioHost({ctx,transaction,
    provider:installModelProvider(ctx,providerConfiguration),permit:endpoint,binding,profile,
    now:()=>asOf,validateSources:createL2ScenarioSourceValidator(traces)}):undefined;
  const management=layered?createLayeredMemoryManagement({ownerId:owner,transaction:work=>storage.businessTransaction(work),
    now:()=>asOf,modelWorkAvailable:()=>true}):undefined;
  const runtime=layered?undefined:await createHostReplyRuntime({ctx,storage,arbiter,ledger,
    token:process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN!,publicRuntime:true,
    extractionEnabled:true,extractionAdoptionEnabled:true,extractionPermit:endpoint,sourceTraces:traces,
    configuration:{skillsRoot,provider:providerConfiguration,
      model:{...binding,physical_limit:16,deadline_ms:20000,warning_ratio:0.8,budgetProfile:profile}}});
  const captureStore=domain==='skill_learning'?new SkillLearningStore({transaction:work=>storage.businessTransaction(work),
    files:new SkillFiles(skillsRoot),taskStore:new ExtractionTaskStore(pool)}):undefined;
  const active=new Set<Promise<unknown>>();
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN}`){res.writeHead(401);res.end('{}');return;}
    const url=new URL(req.url??'','http://localhost');
    if(runtime&&await runtime.handle(req,res))return;
    let raw='';for await(const part of req)raw+=part;
    const body=raw?JSON.parse(raw):undefined,signal=new AbortController().signal;
    const operation=(async()=>{
      try{
        let result:unknown;
        if(captureStore&&url.pathname==='/probe/learning-capture')result=await captureStore.capture(body.scope);
        else if(layered&&url.pathname==='/internal/layered-memory/run')result=await layered.run(body.scope,body.claim,signal);
        else if(management){const value=await management.handle(req.method??'',url,body,signal);if(value){res.writeHead(value.status);res.end(stringifyJson(value.body));return;}}
        else if(runtime&&url.pathname.includes('/skill-learning')){
          const value=await runtime.handleSkillLearning(req.method??'',url,body,signal);res.writeHead(value.status);res.end(stringifyJson(value.body));return;
        }
        if(result===undefined){res.writeHead(404);res.end('{}');return;}
        res.setHeader('content-type','application/json');res.end(stringifyJson(result));
      }catch(error){res.writeHead(409);res.end(stringifyJson({error:(error as any).code??'synthetic_business_failed'}));}
    })();active.add(operation);try{await operation;}finally{active.delete(operation);}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.effect(()=>async()=>{
    ready();runtime?.stopAccepting();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    await Promise.allSettled(active);await runtime?.close();await permits.shutdown();await pool.end();await storage.close();
  });
}
