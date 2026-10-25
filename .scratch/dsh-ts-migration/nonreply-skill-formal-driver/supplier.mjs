/** 合成HTTP供应商只返回协议响应；草稿始终由真实业务校验/落库。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha} from './snapshot.mjs';
const sse=(event,value)=>`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
export async function createSupplier({contexts,directory}){
  const wire=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw),user=body.messages.filter(m=>m.role==='user').at(-1),text=typeof user.content==='string'?user.content:user.content.map(b=>b.text??'').join('');
    const payload=JSON.parse(text),target=payload.existing_skills?.[0];
    const context=[...contexts.values()].find(c=>c.prepared?.batch.targets?.[0]?.skill_id===target?.skill_id);
    assert.ok(context,'supplier_independent_target_binding_required');
    const name=body.tools?.[0]?.name??body.tools?.[0]?.function?.name;assert.equal(name,'SkillLearningProposal');
    const record={run_id:context.run.run_id,scenario:context.mode,path:req.url,request_raw:raw,request_sha256:sha(raw),received_at:new Date().toISOString()};wire.push(record);
    if(context.mode==='failure'){
      record.http_status=503;record.response_raw='{"error":{"message":"synthetic_skill_fault","type":"server_error"}}';
      res.writeHead(503,{'content-type':'application/json'});res.end(record.response_raw);return;
    }
    if(context.mode==='cancel'){await context.cancel();record.cancel_persisted_before_response=true;}
    const late=context.run.material.input.events.find(e=>e.event==='synthetic_late_result')?.text;
    const args={outcome:'draft',proposal_kind:'update',target_skill_ids:[target.skill_id],name:target.name,
      description:'用于拒绝场景的方法建议，等待人工审核。',scene:'合成拒绝方法',
      scope_suggestion:{kind:'contact',reason:'仅供当前关系的人工审核，不自动扩大范围。'},
      methods:[{key:context.mode==='cancel'?'clear-refusal-first':'thanks-before-refusal',title:context.mode==='cancel'?'先明确拒绝':'致谢后拒绝',
        instruction:context.mode==='cancel'?late:'先感谢邀请，再清楚表达拒绝，避免模糊答应。',replaces_method_ids:target.methods.map(m=>m.method_id)}]};
    assert.ok(args.methods[0].instruction,'nonempty_tool_proposal_required');
    if(req.url==='/anthropic/v1/messages'){
      const events=[['message_start',{type:'message_start',message:{id:'synthetic-skill',model:'synthetic-loopback',usage:{input_tokens:24,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}],
        ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-proposal',name,input:{}}}],
        ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}}],
        ['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:17}}],['message_stop',{type:'message_stop'}]];
      record.response_raw=events.map(([type,event])=>sse(type,event)).join('');
    }else{
      assert.equal(req.url,'/v1/chat/completions');assert.equal(body.stream,true);
      const chunk=delta=>({id:'synthetic-skill',object:'chat.completion.chunk',created:1,model:'synthetic-loopback',choices:[{index:0,delta,finish_reason:null}]});
      const chunks=[chunk({role:'assistant',tool_calls:[{index:0,id:'synthetic-proposal',type:'function',function:{name,arguments:''}}]}),
        chunk({tool_calls:[{index:0,function:{arguments:JSON.stringify(args)}}]}),
        {id:'synthetic-skill',object:'chat.completion.chunk',created:1,model:'synthetic-loopback',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:24,completion_tokens:17,total_tokens:41}}];
      record.response_raw=chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n';
    }
    if(context.mode==='unknown')record.response_raw=record.response_raw.replace(/event: message_stop\ndata: .*?\n\n|data: \[DONE\]\n\n/gs,'');
    record.http_status=200;record.response_sha256=sha(record.response_raw);record.nonempty_proposal=true;
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(record.response_raw);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {origin:'http://127.0.0.1:'+server.address().port,wire,
    async close(){server.closeAllConnections();await new Promise(done=>server.close(done));await writeFile(join(directory,'supplier-wire.json'),JSON.stringify(wire,null,2),{mode:0o600});}};
}
