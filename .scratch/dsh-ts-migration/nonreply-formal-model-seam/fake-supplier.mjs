/** 显式 loopback 假供应商；无法构造外部 URL，不消费 oracle。 */
import assert from 'node:assert/strict';
import {createServer,request,validateHeaderValue} from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {hash} from './formal-executor.mjs';
import {responseEnvelopeComplete} from '../ticket25-final-run/vendor-forward.mjs';
export async function createFakeSupplier({contexts,directory,faultStatus=0}){
  const wire=[],server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw),context=contexts.get(decodeURIComponent(req.headers['x-synthetic-run']));assert.ok(context,'unplanned_fake_request');
    if(faultStatus){const response='{"error":"synthetic_supplier_fault"}';wire.push({run_id:context.run.run_id,path:req.url,request_raw:raw,response_raw:response,status:faultStatus});res.writeHead(faultStatus,{'content-type':'application/json'});res.end(response);return;}
    const {run,prepared}=context,index=run.material.targets[0],[speaker,text]=run.material.messages[index],mid=prepared.messages[index];
    const tools=body.tools??[],name=tools[0]?.name??tools[0]?.function?.name;
    const fact={text,category:'common_fact',subject:speaker==='self'?'self':'contact',topic:'other',source_message_ids:[mid],
      confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',
      alternatives:[],interpretation_reason:'只验证非空传输与来源接线的逐字回显。',event:null,conditions:null};
    const args=name==='DirectMemoryExtractionOutput'?{scenes:[{scene_name:'合成来源',memories:[fact]}]}:
      {results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:mid,quote:text}]}]};
    assert.ok(['DirectMemoryExtractionOutput','SourceVerificationOutput'].includes(name),'fake_schema_unknown');
    let response,contentType;
    if(req.url==='/anthropic/v1/messages'){
      contentType='text/event-stream';
      const events=[{type:'message_start',message:{id:'synthetic-only',model:'synthetic-model',usage:{input_tokens:12,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-call',name,input:{}}},
        {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
        {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:9}},{type:'message_stop'}];
      response=events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    }else{
      contentType='application/json';response=JSON.stringify({id:'synthetic-only',object:'chat.completion',model:'synthetic-model',
        choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'synthetic-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],
        usage:{prompt_tokens:12,completion_tokens:9}});
    }
    wire.push({run_id:run.run_id,path:req.url,request_raw:raw,response_raw:response,content_type:contentType});
    res.writeHead(200,{'content-type':contentType});res.end(response);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  return {wire,port:{async validate({request:input,binding}){
    validateHeaderValue('x-synthetic-run',encodeURIComponent(binding.run_id));
    assert.ok(['/anthropic/v1/messages','/beta/chat/completions','/v1/chat/completions'].includes(input.path),'fixed_fake_route_required');
    assert.equal(hash(input.raw),binding.request_sha256,'actual_request_bytes_changed');return true;
  },async send({request:input,binding,beforeWrite,signal}){
    // 与真实 relay 相同：最终 raw 及 ACK 完成后才进入一次物理 HTTP，没有重试和 redirect。
    const raw=input.raw,send_ack=await beforeWrite(raw);
    const response=await new Promise((done,reject)=>{
      const outgoing=request(endpoint+input.path,{method:'POST',headers:{'content-type':'application/json','x-synthetic-run':encodeURIComponent(binding.run_id)},signal},incoming=>{
        let body='';incoming.on('data',b=>{body+=b;});incoming.on('end',()=>done({body,status:incoming.statusCode,contentType:incoming.headers['content-type']}));incoming.on('error',reject);
      });outgoing.on('error',reject);outgoing.end(raw);
    });
    const complete=responseEnvelopeComplete(input.route==='messages'?'new':'old',response.status,response.body);
    return {send_ack,physical_attempted:true,terminal_status:complete?'complete':'unknown',response_sha256:hash(response.body),
      response_model:null,response_fingerprint:null,usage:null,cost:null,http_status:response.status,content_type:response.contentType,
      raw_response:response.body};
  }},async close(){server.closeAllConnections();await new Promise(done=>server.close(done));await writeFile(join(directory,'fake-wire.json'),JSON.stringify(wire,null,2),{mode:0o600});}};
}
