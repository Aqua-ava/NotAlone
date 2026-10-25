/** 合成验收插件仍由真实官方 profile 加载；无产品存储或身份替身声明。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {generateReplyLoop} from '../src/reply-loop.ts';
import {createEvidenceAliases} from '../src/reply-evidence-alias.ts';
import {installModelProvider} from '../src/model-provider.ts';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import type {ModelLedgerReceipt} from '../src/model-ledger.ts';
import {randomUUID,createHash} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {ReplySkillSession} from '../src/reply-skill-runtime.ts';
export const name='notalone-reply-runtime-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export function apply(ctx:Context) {
  const records:ModelLedgerReceipt[]=[],reservations:ModelLedgerReceipt[]=[];
  const skillChecks:{open_at_commit:boolean;closed_after:boolean;use:unknown}[]=[];
  const provider=installModelProvider(ctx,{provider:'notalone-reply-guarded',
    connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),
    resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never});
  let permits=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/health') {res.end(JSON.stringify({records,reservations,skillChecks,permits}));return;}
    try {
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      let current=true;
      const ports={
        requireCurrent:async()=>{if(!current)throw new Error('reply_context_invalidated');},
        acquire:async()=>{permits++;return {id:randomUUID(),settle:async()=>{permits--;}};},
      };
      if(req.url==='/loop') {
        const tools=body.withTool?[defineTool({name:'conversation_search',description:'合成工具协议测试',parameters:{query:{type:'string',required:true}},output:{schema:{type:'string'},render:(_a,result)=>[{type:'text',text:result}]},async execute(){if(body.revokeAfterTool)current=false;return '合成工具协议结果，不是生产检索';}})]:[];
        let skillSession:ReplySkillSession|null=null;
        const check={open_at_commit:false,closed_after:false,use:null as unknown};
        if(body.withSkill){
          const content='仅用于官方运行时协议验收的合成策略',hash=createHash('sha256').update(content).digest('hex');
          const entry={skillId:'50000000-0000-4000-8000-000000000001',versionId:'60000000-0000-4000-8000-000000000001',name:'synthetic',description:'合成策略',contentHash:hash,resourcePaths:[]};
          skillSession=await ReplySkillSession.open({catalog:async()=>({revision:'1',entries:[entry]}),validate:ports.requireCurrent,loadVersion:async()=>({content,contentHash:hash}),resource:async()=>{throw Error('unused');},
            captureUse:async(_scope,e,_revision,meta)=>({skill_id:e.skillId,version_id:e.versionId,name:e.name,version_number:1,scope_kind:'contact',scope_contact_id:'20000000-0000-4000-8000-000000000001',scope_scene:null,execution_view:{policy_revision:0,method_ids:[],sha256:hash},resource_paths:[...meta.resource_paths??[]],load_state:meta.load_state??'loaded',selection_method:meta.selection_method??'auto',selection_reason:meta.selection_reason??''}),
          },{ownerId:'10000000-0000-4000-8000-000000000001',contactId:'20000000-0000-4000-8000-000000000001',scene:''},{skill_version_id:entry.versionId,skill_disabled:false});
          tools.push(...skillSession.tools() as typeof tools);
        }
        const result=await generateReplyLoop(ctx,{owner_id:'10000000-0000-4000-8000-000000000001',contact_id:'20000000-0000-4000-8000-000000000001',request_id:'30000000-0000-4000-8000-000000000001',provider:'notalone-reply-guarded',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',system_prompt:'仅验证合成回复协议，不执行外部动作。',prompt:'请通过ReplyRuntimeOutput返回合成候选。',physical_limit:body.physical_limit??2,deadline_ms:body.deadline_ms??2000},{...ports,provider,budgetProfile:{context_window_tokens:body.exceeded?300:65536,safety_margin_tokens:128},reserve:async receipt=>{reservations.push(receipt);},record:async receipt=>{records.push(receipt);},skillSession,persist:async()=>{await ports.requireCurrent();if(skillSession){check.open_at_commit=!skillSession.runtime.signal.aborted;check.use=skillSession.use;}},evidenceIds:()=>new Set(['40000000-0000-4000-8000-000000000001']),aliases:createEvidenceAliases(['40000000-0000-4000-8000-000000000001']),tools},new AbortController().signal);
        if(skillSession){check.closed_after=skillSession.runtime.signal.aborted;skillChecks.push(check);}
        res.end(JSON.stringify(result));return;
      }
      res.statusCode=404;res.end(JSON.stringify({error:'not_found'}));
    } catch(error) {res.statusCode=422;res.end(JSON.stringify({error:error instanceof Error?error.message:'failed'}));}
  });
  const ready=ctx.appReady!.onReady(()=>{server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${a.port}\n`);});});
  ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await provider.dispose();});
}
