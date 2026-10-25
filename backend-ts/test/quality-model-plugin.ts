/** 合成官方profile只暴露测试调用入口，无产品发送或真实配置。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import pg from 'pg';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/model-provider.ts';
import {createQualityModelCaller} from '../src/quality-model-caller.ts';
import {qualityModelRequestId} from '../src/quality-model-authorization.ts';
import {OrganizationQualityStore} from '../src/organization-quality-store.ts';
import {OrganizationQualityError} from '../src/organization-quality-contract.ts';

export const name='quality-model-synthetic';
export const inject=['llm','appReady'];
export function apply(ctx:Context){
  const config=JSON.parse(process.env.NOTALONE_QUALITY_MODEL_CONFIG!);
  const pool=new pg.Pool({host:'/tmp',database:config.database,max:4});
  const transaction=async<T>(work:(client:pg.PoolClient)=>Promise<T>)=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  const store=new OrganizationQualityStore({transaction,contract:config.contract});
  const provider=installModelProvider(ctx,{provider:'synthetic-route',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,
    thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-quality' as never});
  const caller=createQualityModelCaller({ctx,provider,permit:{path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!}});
  const pending=new Set<Promise<unknown>>();
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);
    if(body.inspectBudgetBinding){
      if(body.removeEnvironment){delete process.env.NOTALONE_PROBLEM_BUDGET;delete process.env.NOTALONE_PROBLEM_ROUND;}
      if(body.injectEnvironment){process.env.NOTALONE_PROBLEM_BUDGET='/synthetic-unopened-budget';process.env.NOTALONE_PROBLEM_ROUND='synthetic';}
      res.end(JSON.stringify({provider:provider.diagnosticProblemBudgetBound,caller:caller.diagnosticProblemBudgetBound}));return;
    }
    const active=body.active,phase=body.phase??'l2_proposal',attemptId=body.attempt_id??randomUUID();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
    let checks=0;
    const work=caller.call({owner_id:body.owner_id??active.owner_id,contact_id:body.contact_id===undefined?active.contact_id:body.contact_id,
      run_id:active.run_id,case_id:active.id,execution_token:body.execution_token??active.execution_token,phase,
      request_id:body.request_id??qualityModelRequestId(active.run_id,active.id,phase),attempt_id:attemptId,
      binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
      profile:{context_window_tokens:32000,safety_margin_tokens:512},messages:[{role:'user',content:[{type:'text',text:body.text??'合成质量输入'}]}],signal:controller.signal,
      requireCurrent:async()=>{
        await store.checkExecution(active.owner_id,active.id,body.execution_token??active.execution_token);
        if(++checks===body.cancelAtCheck)controller.abort();
      },
      onDispatch:async value=>{
        if(body.max_request_characters!==undefined&&(!Number.isSafeInteger(value.measurements?.request_entity_characters)
          ||Number(value.measurements?.request_entity_characters)>body.max_request_characters))throw new OrganizationQualityError('actual_request_budget_exceeded',409);
        await store.reserveAttempt(active.owner_id,active.run_id,active.id,active.execution_token,phase,value.request_payload,value.request_route,
          {...value.measurements,source_ref:body.source_ref??active.source_ref},attemptId);
      },
      onReceipt:async(receipt,evidence)=>{
        await store.finishExecutionAttempt(active.owner_id,active.id,active.execution_token,attemptId,receipt.outcome,receipt.latency_ms??0,evidence?.response_payload??null,evidence?.measurements??{});
      },
    });
    pending.add(work);
    try{const result=await work;res.end(JSON.stringify({code:'ok',...result}));}
    catch(error){res.end(JSON.stringify({code:error instanceof Error?('code'in error?error.code:error.message):'quality_failed',receipt:error&&typeof error==='object'&&'receipt'in error?error.receipt:null}));}
    finally{clearTimeout(timer);pending.delete(work);}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`QUALITY_MODEL_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.on('dispose',async()=>{ready();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await Promise.allSettled(pending);await provider.dispose();await pool.end();});
}
