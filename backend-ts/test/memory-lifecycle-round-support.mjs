/** 正式生命周期的合成来源与供应商边界；不预置完成回执或画像结果。 */
import {randomUUID} from 'node:crypto';
import {createExtractionPolicyVersion} from '../src/memory/extraction/policy-version.ts';
import {captureSnapshot} from '../src/memory/overview/evidence/sources.ts';

export async function seedRoundInput(f,owner,{contactId=randomUUID(),paused=false,texts=['合成资料：今天去散步。'],verification='complete'}={}){
 const source=randomUUID(),task=randomUUID(),scope=randomUUID(),round=randomUUID(),messages=[];
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成轮次') ON CONFLICT DO NOTHING",[contactId,owner]);
 await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id,intent,control_generation) VALUES($1,$2,$3,$4,$5)',[scope,owner,contactId,paused?'pause':'run',paused?1:0]);
 await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,$5,'waiting','extraction')",[round,scope,owner,contactId,paused?1:0]);
 await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-round.jsonl',$4,$5)",[source,owner,contactId,'d'.repeat(64),texts.length]);
 for(const [index,text] of texts.entries()){
  const id=randomUUID(),occurred=new Date(Date.UTC(2026,9,20,1,index)).toISOString();messages.push({id,text,occurred});
  await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,$5)",[id,owner,contactId,text,occurred]);
  await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,$5,$6)",[id,owner,contactId,source,`synthetic:${index}`,{synthetic:true,time_iso:occurred}]);
 }
 const policy=verification==='legacy'
  ?{version:1,mode:'legacy',rule_set_sha256:null}
  :(await createExtractionPolicyVersion()).newTaskConfig();
 await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,extraction_runtime_config) VALUES($1,$2,$3,$4,'import','queued','extract_memory',$5,$6)",[task,owner,contactId,source,texts.length,policy]);
 await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,total_count) VALUES($1,'parse',1,'succeeded',$2),($1,'normalize',2,'succeeded',$2),($1,'extract_memory',3,'pending',$2),($1,'index',4,'pending',$2),($1,'verify',5,'pending',$2)",[task,texts.length]);
 await f.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',[task,owner,contactId]);
 await f.client.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
  SELECT $1,id,owner_id,contact_id FROM message WHERE id=ANY($2::uuid[])`,[task,messages.map(message=>message.id)]);
 await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contactId]);
 await f.client.query(`INSERT INTO memory_processing_round_target(round_id,task_id,message_id)
  SELECT $1,$2,id FROM message WHERE id=ANY($3::uuid[])`,[round,task,messages.map(message=>message.id)]);
 await f.client.query("UPDATE memory_processing_round SET target_unit='messages',target_count=$2 WHERE id=$1",[round,texts.length]);
 return {contactId,source,task,scope,round,messages};
}

/** 合法自动候选、冻结来源与可核验 trace，供 L2/L3 阶段验收使用。 */
export async function seedRoundMemory(f,owner,{text='双方共同参加过合成课程。',paused=false}={}){
 const seed=await seedRoundInput(f,owner,{paused}),memory=randomUUID(),candidate=randomUUID(),trace=randomUUID();
 await f.client.query("UPDATE source_document SET source_type='manual' WHERE id=$1",[seed.source]);
 const evidence={...await captureSnapshot(f.client,owner,[seed.messages[0].id],[seed.source],seed.contactId),kind:'generation'};
 await f.client.query(`INSERT INTO memory_candidate
  (id,owner_id,contact_id,text_content,category,source_ids,status,correction_evidence)
  VALUES($1,$2,$3,$4,'common_fact',$5,'confirmed',$6::jsonb)`,
 [candidate,owner,seed.contactId,text,[seed.source],JSON.stringify(evidence)]);
 await f.client.query(`INSERT INTO confirmed_memory
  (id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method,status,revision)
  VALUES($1,$2,$3,$4,'common_fact','study',$5,$6,'auto','active',1)`,
 [memory,owner,seed.contactId,text,[seed.source],candidate]);
 await f.client.query(`INSERT INTO memory_extraction_trace
  (trace_id,owner_id,contact_id,run_id,batch_key,status,finished_at)
  VALUES($1,$2,$3,$4,$5,'succeeded',now())`,
 [trace,owner,seed.contactId,randomUUID(),randomUUID()+randomUUID()]);
 await f.client.query(`INSERT INTO memory_extraction_trace_link
  (trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status,operation)
  VALUES($1,$2,$3,NULL,'contact_memory',$4,'committed','save')`,
 [trace,owner,seed.contactId,memory]);
 for(const dependency of [seed.source,seed.messages[0].id])
  await f.client.query(`INSERT INTO memory_extraction_trace_dependency
   (trace_id,owner_id,contact_id,source_id) VALUES($1,$2,$3,$4)`,
  [trace,owner,seed.contactId,dependency]);
 const ref=(await f.client.query(`SELECT id,source_locator
  FROM message_source_ref WHERE message_id=$1`,[seed.messages[0].id])).rows[0];
 const windowPayload={version:1,owner_id:owner,contact_id:seed.contactId,
  target_message_ids:[seed.messages[0].id],messages:[{
   message_id:seed.messages[0].id,text,sender:'contact',source_snapshots:[{
    source_ref_id:ref.id,source_id:seed.source,source_kind:'source_document',
    locator:ref.source_locator,source_content_sha256:'d'.repeat(64),
   }],
  }]};
 await f.client.query(`INSERT INTO memory_extraction_trace_event
  (event_id,trace_id,owner_id,contact_id,position,stage,payload)
  VALUES($1,$2,$3,$4,1,'window',$5::jsonb),($6,$2,$3,$4,2,'batch_end',$7::jsonb)`,
 [randomUUID(),trace,owner,seed.contactId,JSON.stringify(windowPayload),randomUUID(),
  JSON.stringify({status:'succeeded',watermark_message_id:seed.messages[0].id})]);
 await f.client.query(`INSERT INTO layered_memory_state
  (owner_id,contact_id,enabled,settings_generation,status,organization_generation)
  VALUES($1,$2,true,1,'stale',0) ON CONFLICT DO NOTHING`,[owner,seed.contactId]);
 await f.client.query(`UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',
  organization_generation=0 WHERE owner_id=$1 AND contact_id=$2`,[owner,seed.contactId]);
 return {...seed,memory,candidate,trace};
}

export function sendSyntheticTool(res,name,args){
 res.setHeader('content-type','text/event-stream');
 const events=[{type:'message_start',message:{id:randomUUID(),model:'deepseek-chat',usage:{input_tokens:3,output_tokens:0}}},
  ...(name?[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
   {type:'content_block_stop',index:0}]:
   [{type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'已完成。'}},
    {type:'content_block_stop',index:0}]),
  {type:'message_delta',delta:{stop_reason:name?'tool_use':'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
 res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

export function sendSyntheticStrictTool(res,name,args){
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify({id:`synthetic-${randomUUID()}`,object:'chat.completion',
  choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
   tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],
  usage:{prompt_tokens:3,completion_tokens:2,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:3}}));
}

export async function untilLifecycle(read,timeoutMs=12000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error('合成正式生命周期未在期限内到达预期状态');
}
