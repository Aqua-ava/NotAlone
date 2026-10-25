/** 官方profile内装配真实ModelHost与生产Skill单次runner；不注册模型业务Tool。 */
import type {Context} from '@deepseek-ai/cordis';
import {isTokenDelta} from '@deepseek-ai/dsh-llm/assistant-stream';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HostStorage} from '../../../backend-ts/src/host-storage.ts';
import {startModelHost} from '../../../backend-ts/src/model-host.ts';
import {createHostModelAccounting} from '../../../backend-ts/src/host-model-accounting.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../../../backend-ts/src/model-ledger.ts';
import {createHostReplyRuntime} from '../../../backend-ts/src/host-reply.ts';
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host-reply-config.ts';
import {ExtractionTaskStore} from '../../../backend-ts/src/extraction-task-store.ts';
import {SkillFiles} from '../../../backend-ts/src/skill-files.ts';
import {SkillLearningStore} from '../../../backend-ts/src/skill-learning-store.ts';
import {SkillLearningRuntime} from '../../../backend-ts/src/skill-learning-runtime.ts';
import {SkillLearningTaskRunner} from '../../../backend-ts/src/skill-learning-worker.ts';
export const name='notalone-skill-formal-driver';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  const environment=process.env,home=environment.HOME!,database=environment.NA_SKILL_DATABASE!,owner=environment.NA_SKILL_OWNER!;
  const scope={owner_id:owner,contact_id:environment.NA_SKILL_CONTACT!},token=environment.NA_SKILL_TOKEN!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database))throw Error('synthetic_database_required');
  for(const key of ['HOST','REPLY','EXTRACTION','EXTRACTION_B','TASK_WORKER','LAYERED_MEMORY','SKILL_LEARNING'])
    if(environment['NOTALONE_'+key+'_RUNTIME']!=='typescript')throw Error('complete_typescript_responsibility_required');
  if(environment.NOTALONE_PROBLEM_BUDGET!==undefined||environment.NOTALONE_PROBLEM_ROUND!==undefined)
    throw Error('inner_problem_budget_would_double_reserve');
  const envFilePath=join(home,'unused-synthetic-config'),skillsRoot=environment.NA_SKILL_FILES!;
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../../backend/database/migrations/',import.meta.url).pathname,
    environment:{HOME:home,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:'host=/tmp dbname='+database,NOTALONE_OWNER_ID:owner}});
  const transaction=storage.businessTransaction.bind(storage),pool=await storage.businessPool();
  const effective=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  if(effective.status!=='configured')throw Error('model_configuration_unavailable');
  let modelHost:Awaited<ReturnType<typeof startModelHost>>;
  const accounting=createHostModelAccounting({transaction,provider:'deepseek',typescriptProvider:effective.provider.provider,
    model:effective.model.model,unconfirmedPermitIds:()=>modelHost?.unconfirmedPermitIds()??[]});
  modelHost=await startModelHost({runtimeEnvironment:{HOME:home,NOTALONE_EXTRACTION_BATCH_CONCURRENCY:'1'},businessHome:home,
    infoPath:join(home,'model-info.json'),envFilePath,accounting});
  const runtime=await createHostReplyRuntime({ctx,storage,arbiter:modelHost.arbiter,token,publicRuntime:true,
    ledger:new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()}),
    extractionPermit:{path:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET,token:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_TOKEN},
    configuration:{skillsRoot,model:effective.model,provider:{...effective.provider,
      connection:{...effective.provider.connection,baseURL:environment.NA_SKILL_BROKER!+'/anthropic'},
      resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-only' as never}}});
  const tasks=new ExtractionTaskStore(pool),store=new SkillLearningStore({transaction,files:new SkillFiles(skillsRoot),taskStore:tasks});
  const events:Record<string,unknown>[]=[];let started=0,claim:any,batch:any,invocations=0;
  const event=(type:string,details:Record<string,unknown>={})=>events.push({type,at_ms:performance.now()-started,...details});
  const originalSave=store.save.bind(store);
  store.save=async(...args)=>{event('persistence_start');try{return await originalSave(...args);}finally{event('persistence_end');}};
  const observe=ctx.on('llm/stream',async function*(options,next){
    event('network_start');try{for await(const chunk of next()){
      event('model_stream_chunk',{chunk_type:chunk.type,is_token_delta:isTokenDelta(chunk)});yield chunk;
    }}finally{event('network_end');}
  });
  const m=effective.model;
  const proposals=new SkillLearningRuntime({store,call:input=>runtime.callExtraction({...input,signal:AbortSignal.any([input.signal,AbortSignal.timeout(m.deadline_ms)])}),
    binding:{provider:m.provider,model:m.model,maxTokens:m.maxTokens,temperature:m.temperature,reasoningEffort:m.reasoningEffort},profile:m.budgetProfile});
  const runner=new SkillLearningTaskRunner({store,runtime:proposals}),active=new Set<Promise<unknown>>();
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
    const operation=(async()=>{
      let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):undefined;
      const url=new URL(req.url??'','http://localhost'),signal=new AbortController().signal;
      try{
        let value:unknown;
        if(url.pathname==='/driver/open'){
          if(claim)throw Error('single_claim_only');started=performance.now();event('business_service_start',{at_ms:0,wall_at:new Date().toISOString()});
          const configured=await runtime.handleSkillLearning('POST',new URL(`/api/contacts/${scope.contact_id}/skill-learning`,url),
            {enabled:true,confirmed:true,operation_key:randomUUID(),expected_revision:0},signal);
          if(configured.status!==200)throw Error('learning_authorization_failed');
          const taskId=await store.enqueue(scope);if(!taskId)throw Error('nonempty_learning_batch_required');
          claim=await tasks.claim({ownerId:owner,contactId:scope.contact_id},{taskId,workerId:randomUUID(),leaseMs:120000,supportedSteps:['propose_skill']});
          if(!claim)throw Error('learning_claim_required');event('queue_end');batch=await store.capture(scope);
          value={claim,batch,events};
        }else if(url.pathname==='/driver/run'){
          if(!claim||invocations++)throw Error('single_runner_invocation_only');let status='succeeded',result:any,error_code:string|null=null;
          try{
            result=await runner.run(claim,signal);await tasks.complete(claim,result.processedCount,result.totalCount);
            const verification=await tasks.claim({ownerId:owner,contactId:scope.contact_id},{taskId:claim.taskId,workerId:randomUUID(),leaseMs:120000,supportedSteps:['verify_skill_drafts']});
            if(!verification)throw Error('verification_claim_required');
            const verified=await runner.run(verification,signal);await tasks.complete(verification,verified.processedCount,verified.totalCount);
          }
          catch(error){
            error_code=(error as any).code??'skill_learning_run_failed';
            const state=(await pool.query('SELECT enabled FROM skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',[owner,scope.contact_id])).rows[0];
            status=state?.enabled?'failed':'cancelled';
            if(status==='failed')await tasks.fail(claim,error_code,false);
          }
          event('business_service_end',{outcome:status});value={terminal_status:status,result,error_code,events,automatic_retries:0};
        }else if(url.pathname.includes('/skill-learning')){
          const answer=await runtime.handleSkillLearning(req.method??'',url,body,signal);res.writeHead(answer.status);res.end(JSON.stringify(answer.body));return;
        }else {res.writeHead(404);res.end('{}');return;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
      }catch(error){res.writeHead(409);res.end(JSON.stringify({error:(error as any).code??(error as Error).message}));}
    })();active.add(operation);try{await operation;}finally{active.delete(operation);}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write('SKILL_READY '+JSON.stringify({url:`http://127.0.0.1:${address.port}`,
      model_host:'startModelHost',model_host_state_path:modelHost.statePath,controls:m,background_worker_started:false,
      ownership:Object.fromEntries(Object.entries(environment).filter(([key])=>key.endsWith('_RUNTIME'))),inner_problem_budget_bound:false})+'\n');
  }));
  ctx.effect(()=>async()=>{ready();runtime.stopAccepting();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    await Promise.allSettled(active);observe();await runtime.close();await modelHost.close(async()=>{});await pool.end();await storage.close();});
}
