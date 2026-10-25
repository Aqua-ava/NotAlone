/** 与固定合成来源逐字对应的供应商回显；不读取oracle或生产数据。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {sha} from './attempt-journal.mjs';
export async function startSyntheticUpstream({contexts,status=200}){
  const wire=[];const server=createServer(async(req,res)=>{try{
    let raw='';for await(const b of req)raw+=b;
    const body=JSON.parse(raw),arm=req.url==='/v1/chat/completions'?'old':'new',context=[...contexts.values()].find(c=>c.run.arm===arm);
    assert.ok(context,'synthetic_context_missing');const {run,prepared}=context;
    const entry={arm,path:req.url,request_sha256:sha(raw),request_raw:raw,status};wire.push(entry);
    if(status!==200){res.writeHead(status,{'content-type':'application/json'});res.end('{"error":{"type":"synthetic_fault","message":"合成故障"}}');return;}
    const index=run.material.targets[0],[speaker,text]=run.material.messages[index],mid=prepared.messages[index];
    const name=body.tools?.[0]?.name??body.tools?.[0]?.function?.name;
    assert.ok(['DirectMemoryExtractionOutput','SourceVerificationOutput'].includes(name),'synthetic_tool_unverified');
    const fact={text,category:'common_fact',subject:speaker==='self'?'self':'contact',topic:'other',source_message_ids:[mid],confidence:0.9,risk_flags:[],
      valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成来源逐字回显。',event:null,conditions:null};
    const args=name==='DirectMemoryExtractionOutput'?{scenes:[{scene_name:'合成来源',memories:[fact]}]}:
      {results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:mid,quote:text}]}]};
    let response,contentType;
    if(req.url==='/anthropic/v1/messages'){
      contentType='text/event-stream';const events=[{type:'message_start',message:{id:'synthetic-only',model:'synthetic-model',usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-call',name,input:{}}},
        {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},{type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:9}},{type:'message_stop'}];
      response=events.map(v=>'event: '+v.type+'\ndata: '+JSON.stringify(v)+'\n\n').join('');
    }else{
      contentType='application/json';response=JSON.stringify({id:'synthetic-only',object:'chat.completion',model:'synthetic-model',
        choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'synthetic-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],
        usage:{prompt_tokens:12,completion_tokens:9,prompt_cache_hit_tokens:0}});
    }
    Object.assign(entry,{response_raw:response,response_sha256:sha(response)});res.writeHead(200,{'content-type':contentType});res.end(response);
  }catch{res.writeHead(500);res.end('{"error":"synthetic_upstream_failed"}');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {wire,origin:'http://127.0.0.1:'+server.address().port,async close(){server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
